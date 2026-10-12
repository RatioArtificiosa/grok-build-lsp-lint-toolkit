# Grok LSP Toolkit

**Seven languages. Real language servers. Live diagnostics. One install.**

Language servers, formatters and linters for [Grok Build](https://x.ai), working together on macOS, Linux and Windows.

```bash
git clone https://github.com/RatioArtificiosa/Grok-Build-LSP-Lint-Toolkit
cd Grok-Build-LSP-Lint-Toolkit
node install.mjs
```

That's it. Restart Grok Build and your agent stops guessing about your code.

---

## Why this exists

An AI coding agent with no view of your code is working blind. It reads a file, edits a file, and finds out whether it was right when the build fails, or when you tell it.

Give it a language server and that changes. It sees the type of the expression it is about to change. It gets Clippy's verdict on the line it just wrote. It knows the import it just added does not resolve, five seconds after adding it, instead of five minutes later at the end of a gate run.

Grok Build supports all of this. It just does not ship with the servers, and wiring them up by hand is fiddly enough that most people never do it. This repository is that wiring, done properly, for seven languages, and it works the same way on every platform.

---

## What you get

| Language | Language server | Formatter | Linter |
|---|---|---|---|
| **Rust** | rust-analyzer | rustfmt | Clippy, through the server |
| **Python** | Pyright | Ruff | Ruff |
| **Go** | gopls | gofmt | gopls |
| **C / C++** | clangd | clang-format | clang-tidy, through the server |
| **TypeScript / JavaScript** | TypeScript language server | Biome | Biome |
| **Zig** | zls | `zig fmt` | zls |
| **AssemblyScript** | *(uses the TypeScript server)* | none needed | ESLint |

Each plugin does two jobs:

- **A language server.** Hover, go-to-definition, references, symbols and live diagnostics, delivered to the model as it works.
- **A formatter on write.** The moment a file is saved by the agent, the formatter for that language runs on it. Clean code without a follow-up instruction.

Plus one thing you will not find elsewhere, described next.

---

## The bug this toolkit fixes

Some LSP clients, including Grok Build today, never send the `textDocument/didOpen` notification. That is the message a client uses to tell a language server *what is actually in the file*.

The consequence is subtle and misleading. Ask for a **hover** and you get nothing back. Ask for a **go-to-definition** and you get `null`. But ask for **document symbols** and it works fine, because many servers quietly fall back to reading the file from disk, and that fallback hides the problem.

So it looks like *"hover is broken"*. It is not. The document was never opened, and every position-based query is being answered against an empty buffer.

**This toolkit ships a fix.** A small, transparent proxy sits between Grok Build and the real language server. It relays every message in both directions untouched, and does exactly one extra thing: when a request needs a document it has not opened yet, it reads the file and sends `didOpen` first.

```
without the proxy     hover -> (empty)      goToDefinition -> null
with the proxy        hover -> fn describe(s: Shape): string
```

It re-reads the file on every request instead of trusting that it was opened once. If the bytes on disk have changed since the server last saw them, it sends `didChange` first, so an answer never comes from a stale copy.

Nothing is rewritten, reordered or dropped. Each message crosses as the exact bytes the client sent, and the parse that decides whether to inject runs on a separate copy, so a request the proxy does not understand still arrives intact. If a frame ever defeats that parse, the proxy stops inspecting and drains the rest of the stream verbatim. The worst case is a plain pipe, never a corrupted one.

`documentSymbol` is included in the set of requests that get a document. Leaving it out is tempting, because it often appears to work already, but that appearance depends on the server falling back to reading the file from disk. Pyright does not, and answers with zero symbols for a document it was never told about. The operation looks safe to ignore and is not.

If a future Grok Build release starts sending `didOpen` itself, the proxy simply has nothing to do.

### What has been measured

Each language below was driven through the proxy with a client that never sends `didOpen`, then compared against the same server called directly by a client that does. Hover text and symbol counts came back identical in every case.

| Language | Server | Hover through the proxy | Symbols |
|---|---|---|---|
| TypeScript / JavaScript | typescript-language-server | `function describe(s: Shape): string` | 3 |
| Python | pyright | `(function) def describe(s: str) -> str` | 5 |
| Go | gopls | `func Describe(t Thing) string` | 3 |
| C / C++ | clangd | ``### function `area` `` then `int` | 3 |
| Rust | rust-analyzer | `pub fn describe(s: Shape) -> String` | 4 |
| Zig | zls | `fn add(a: u32, b: u32) u32` | 4 |

Drift detection was measured the same way. With the client silent, a Python file's return type was changed on disk from `str` to `int`; the next hover reported `int`. The earlier version of this proxy reported `str` forever after the first read, which is exactly the kind of error that makes a wrong answer look like a right one.

Two things that cost real time to discover, both worth knowing before you decide something is broken:

**rust-analyzer says nothing for the first 30 to 60 seconds.** It indexes the workspace before answering anything, and a request made during that window comes back empty rather than delayed. Measured on a small crate: 47 seconds to the first answer cold, under 8 seconds once the build cache is warm. If hover does nothing in a Rust project, wait and try again.

**zls needs a `build.zig`.** With one it answers immediately. Without one it has no module graph to resolve against and looks like a server that never started.

---

## Requirements

- **Grok Build** installed and working.
- **Node.js 18 or newer.** The formatter hooks and the proxy both run on it. It is the only hard dependency.
- **The toolchain for each language you want to use.** A plugin cannot run a formatter that is not installed, and when one is missing the hook says so plainly on stderr rather than failing silently.

Install only the languages you care about. Nothing breaks if a toolchain is absent; that plugin just sits idle.

### Toolchains

<details>
<summary><b>Rust</b></summary>

```bash
rustup component add rust-analyzer rustfmt clippy
```
</details>

<details>
<summary><b>Python</b></summary>

```bash
pip install pyright ruff
```
</details>

<details>
<summary><b>Go</b></summary>

```bash
go install golang.org/x/tools/gopls@latest
```
`gofmt` ships with the Go toolchain.
</details>

<details>
<summary><b>C / C++</b></summary>

Install the LLVM toolchain, or the standalone clangd build:

```bash
brew install llvm              # macOS
sudo apt install clangd clang-format   # Debian / Ubuntu
winget install LLVM.LLVM       # Windows
```
</details>

<details>
<summary><b>TypeScript / JavaScript</b></summary>

```bash
npm install --global @biomejs/biome typescript-language-server typescript@5
```

> **Pin TypeScript to the 5.x line.** `typescript-language-server` drives the compiler through `lib/tsserver.js`, and TypeScript 7 removed that file. A project with TypeScript 7 fails with a message about a *missing* installation rather than a wrong version, which is easy to misread. Install it per project with `npm install --save-dev typescript@5`.
</details>

<details>
<summary><b>Zig</b></summary>

Install [zig](https://ziglang.org/download/), then download the **zls build that matches your zig version exactly**. They are released in pairs and are not interchangeable. zls 0.16.x speaks to zig 0.16.x and to nothing else.

```bash
zig version
zls --version   # these two numbers must agree
```
</details>

<details>
<summary><b>AssemblyScript</b></summary>

Nothing global. ESLint runs through `npx`, and the project needs its own `eslint.config.js`, which a real AssemblyScript project already has.
</details>

---

## Install

```bash
node install.mjs
```

The installer detects your platform, resolves the paths, stages the plugins under `~/.grok`, registers them as a marketplace and installs each one. It also turns on `lsp_tools`, the flag that lets language-server results reach the model. Without that flag the servers run and nothing they say gets through.

Useful flags:

```bash
node install.mjs --dry-run     # show every step, write nothing
node install.mjs --uninstall   # remove the plugins this toolkit installed
```

**Then restart Grok Build.** Its configuration and plugin list are read at startup, so nothing is live until you do.

### Manual install

If you would rather not run a script, the plugins are ordinary Grok Build plugins. Stage them wherever you like, replace the two placeholders yourself (`@FORMAT_ENTRY@` with `bin/format.cmd` on Windows or `bin/format.sh` elsewhere, `@PROXY@` with the absolute path to `lib/lsp-open-proxy.js`), then:

```bash
grok plugin marketplace add /path/to/staged
grok plugin install rust-lsp --trust
```

---

## Verifying it works

After the restart, edit a file in a supported language and ask your agent to look at it. Three things should be true:

1. **The file formats itself.** Write sloppy spacing, save, then look at the file. It is tidy.
2. **Diagnostics arrive.** Edit a `.rs` file that will not compile and Clippy's complaint appears in the session without you asking for it.
3. **Symbols resolve.** Ask for the symbols in a file and get real ones back.

If formatting does nothing, check whether the formatter binary is on `PATH`. That is the usual cause, and the hook will have said so on stderr.

---

## How it works

Each plugin is a directory with four parts:

```
rust-lsp/
  .grok-plugin/plugin.json   what the plugin is called
  .lsp.json                  which language server to start, for which extensions
  hooks/hooks.json           when to run the formatter
  hooks/bin/format.{cmd,sh}  platform entry points, both calling format.js
  skills/setup/SKILL.md      how to install that language's toolchain
```

The formatter hooks are one shared JavaScript file with a two-line platform wrapper. Windows cannot execute a `.sh` and Unix cannot execute a `.cmd`, so both ship and the installer names the right one in `hooks.json`. The logic is the same everywhere: read the event, check the extension, run the formatter.

Extensions are matched case-insensitively, files with unrelated extensions are left completely alone, and a hook that goes wrong exits quietly rather than failing your tool call.

---

## Troubleshooting

**Nothing formats.**
The formatter binary is probably not on `PATH`. Run it yourself from a fresh terminal, with `rustfmt --version` or `ruff --version`. The hook runs with the environment the agent was started in, so a tool installed after that will not be visible until the agent restarts.

**Hover and go-to-definition still return nothing.**
Check `lsp_tools` is on:
```toml
# ~/.grok/config.toml
[features]
lsp_tools = true
```
Then confirm the proxy is present and the path in the plugin's `.lsp.json` points at it.

**The language server starts and answers nothing.**
Usually a version mismatch, most often Zig, where zls and zig must match exactly. Or a project the server cannot understand: rust-analyzer wants a `Cargo.toml`, gopls wants a `go.mod`, clangd wants a `compile_commands.json` for anything beyond the current file.

**A language server never answers at all, and nothing appears on stderr.**
Check the `command` field in the plugin's `.lsp.json`. It must be a bare executable name such as `typescript-language-server`, never a path ending in `.cmd` or `.bat`. Node refuses to spawn those unless a shell is involved, and the failure is invisible from the client's side: the server simply never replies. Bare names are resolved through `PATHEXT` and work correctly, which is why every plugin here uses one.

**Rust hover does nothing.**
Wait. rust-analyzer indexes before it answers, and an empty hover during indexing is indistinguishable from a broken server. If it is still empty after a minute, check that the project is a real cargo workspace and that no stray `Cargo.toml` sits in a parent directory. Cargo searches upward, and a malformed manifest above your project will stop it dead with an error that names the parent file rather than your own.

**A plugin claims an extension another plugin also claims.**
Clients that refuse ambiguous extensions will resolve *neither*. That is why `assemblyscript-lsp` ships no language server: AssemblyScript compiles from `.ts`, and two plugins claiming `.ts` would leave TypeScript with no server at all.

---

## Contributing

Adding a language is mostly a matter of adding a row to the table and a directory beside the others. The two files worth reading first are `lib/format-runner.js`, which holds the whole formatting mechanism, and one plugin's `.lsp.json`, which is four lines of configuration.

If you find a language server that needs a different lifecycle notification, or a client quirk worth papering over, that belongs in `lib/lsp-open-proxy.js` where every plugin benefits from it.

### Testing the proxy

The proxy is the one part of this toolkit that is easy to test wrongly, and a faulty probe produces a confident negative. Three ways a probe lies, each of which cost real time to find:

- **A server that closes stdin while it starts.** rust-analyzer does this during indexing. A probe that writes first and checks the result second reports "the pipe is being closed" and looks like a proxy failure, when the server simply was not listening yet.
- **Matching a reply by assuming field order.** A strict check that expects `result` immediately after `id` reports "no reply" for requests that were answered, because LSP does not guarantee key order in a response object.
- **Sending a burst before the server is ready.** Several requests issued at once outrun a server that is still indexing, and every one of them reads as unanswered.

The shape that works: wait for the answer rather than for a fixed duration, match responses by `id`, and compare a direct call against a proxied one at the same file and position. The proxied run must send no `didOpen` of its own, or it proves nothing about the proxy.


---

## License

MIT. Use it, fork it, ship it.
