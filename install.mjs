#!/usr/bin/env node
// Cross-platform installer for the Grok Build LSP Lint Toolkit.
//
//   node install.mjs               install or update every plugin
//   node install.mjs --dry-run     show what would happen, touch nothing
//   node install.mjs --uninstall   remove the plugins this toolkit installed
//   node install.mjs --verify      check the plugins match lib/, install nothing
//
// What it does, in order:
//   1. locates the Grok CLI
//   2. resolves the two placeholders the shipped files carry - the platform's
//      hook entry point, and the absolute path to the LSP proxy
//   3. copies the resolved plugins to a staging directory under ~/.grok
//   4. registers that directory as a plugin marketplace and installs each plugin
//   5. marks the POSIX entry points executable
//
// Nothing outside ~/.grok is touched, and no file already there is overwritten
// except this toolkit's own staging directory and the proxy.
//
// On the shared files: `lib/` holds the canonical copy of the formatter runner
// and its two platform entry points. Each plugin carries its own identical copy,
// because a Grok plugin has to be a self-contained directory the marketplace can
// install on its own - a plugin that reached outside itself for its hook would
// break for anyone who installed it without this repository. That duplication is
// deliberate, and `--verify` is what keeps it honest.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IS_WINDOWS = process.platform === "win32";
const GROK_HOME = path.join(os.homedir(), ".grok");
const STAGING = path.join(GROK_HOME, "lsp-toolkit");
const PROXY_DEST = path.join(GROK_HOME, "lsp-open-proxy.js");
const HOOK_ENTRY = IS_WINDOWS ? "bin/format.cmd" : "bin/format.sh";

// The proxy path is substituted into a JSON file, and a JSON string treats a
// backslash as an escape character - a Windows path inserted verbatim produces
// `"C:\Users\..."`, where `\U` is not a valid escape and the whole file fails to
// parse. Forward slashes are accepted by Node on every platform and need no
// escaping, so the value is normalised once here rather than escaped per use.
const PROXY_FOR_JSON = PROXY_DEST.split(path.sep).join("/");

const args = new Set(process.argv.slice(2));
const DRY = args.has("--dry-run") || args.has("-n");
const UNINSTALL = args.has("--uninstall");
const VERIFY = args.has("--verify");

const say = (msg) => process.stdout.write(msg + "\n");
const ok = (msg) => say("  \u2713 " + msg);
const warn = (msg) => say("  ! " + msg);
const step = (msg) => say("\n" + msg);

function fail(msg) {
  say("\n  \u2717 " + msg);
  process.exit(1);
}

// ---------------------------------------------------------------- find grok --
function findGrok() {
  const candidates = [
    IS_WINDOWS ? path.join(GROK_HOME, "bin", "grok.exe") : path.join(GROK_HOME, "bin", "grok"),
    IS_WINDOWS ? path.join(GROK_HOME, "bin", "grok.cmd") : null,
  ].filter(Boolean);

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  // fall back to PATH
  const probe = IS_WINDOWS
    ? spawnSync("where", ["grok"], { encoding: "utf8", shell: false })
    : spawnSync("which", ["grok"], { encoding: "utf8", shell: false });
  if (probe.status === 0 && probe.stdout.trim()) {
    return probe.stdout.trim().split(/\r?\n/)[0];
  }
  return null;
}

// ------------------------------------------------------------- plugin list --
function readPlugins() {
  const dir = path.join(HERE, "plugins");
  if (!fs.existsSync(dir)) fail("no plugins/ directory next to install.mjs");
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

// ----------------------------------------------------------------- verify --
//
// The formatter runner and its two platform entry points exist once in lib/ and
// once inside each plugin. The copies have to stay identical, or one plugin will
// behave differently from the one beside it and nothing will say so until
// somebody edits a file in that language. This compares them and names any that
// have drifted, so the difference is caught here rather than in the field.
function verifyShared() {
  const shared = [
    ["format-runner.js", "format.js"],
    ["format.cmd", "format.cmd"],
    ["format.sh", "format.sh"],
  ];
  const plugins = readPlugins();
  let drift = 0;
  let checked = 0;

  say("Checking " + plugins.length + " plugins against lib/");

  // Line endings are normalised before comparing. A Windows checkout has CRLF
  // and a Linux one has LF, and that is the repository's business rather than a
  // sign that the files disagree.
  const normalise = (text) => text.replace(/\r\n/g, "\n");

  for (const [source, target] of shared) {
    const canonical = normalise(fs.readFileSync(path.join(HERE, "lib", source), "utf8"));
    for (const name of plugins) {
      const copyPath = path.join(HERE, "plugins", name, "hooks", "bin", target);
      if (!fs.existsSync(copyPath)) {
        warn(name.padEnd(20) + target.padEnd(18) + "missing");
        drift++;
        continue;
      }
      checked++;
      if (normalise(fs.readFileSync(copyPath, "utf8")) !== canonical) {
        warn(name.padEnd(20) + target.padEnd(18) + "differs from lib/" + source);
        drift++;
      }
    }
  }

  say("");
  if (drift === 0) {
    ok(checked + " files identical to lib/");
    say("");
    return;
  }
  fail(
    drift +
      " of " +
      (checked + drift) +
      " files have drifted from lib/.\n" +
      "    Update the plugin copy from the canonical file in lib/."
  );
}

// ------------------------------------------------- copy with substitution --
function copyTree(src, dest, replacements) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyTree(from, to, replacements);
      continue;
    }
    let data = fs.readFileSync(from);

    // Substitute placeholders only in the small text files that carry them.
    if (/\.(json|cmd|sh|js|md)$/i.test(entry.name)) {
      let text = data.toString("utf8");
      for (const [token, value] of Object.entries(replacements)) {
        text = text.split(token).join(value);
      }
      data = Buffer.from(text, "utf8");
    }
    fs.writeFileSync(to, data);

    // POSIX entry points must be executable or the harness cannot spawn them.
    if (!IS_WINDOWS && /\.sh$/i.test(entry.name)) {
      fs.chmodSync(to, 0o755);
    }
  }
}

// ------------------------------------------------------------------ install --
function install() {
  if (VERIFY) return verifyShared();

  const grok = findGrok();
  if (!grok) {
    fail(
      "could not find the Grok CLI.\n" +
        "    Install Grok Build first, or add its bin directory to PATH.\n" +
        "    Looked for: " +
        path.join(GROK_HOME, "bin")
    );
  }

  say("Grok Build LSP Lint Toolkit installer");
  say("  platform    " + process.platform + " (" + process.arch + ")");
  say("  grok        " + grok);
  say("  hook entry  " + HOOK_ENTRY);
  say("  staging     " + STAGING);
  if (DRY) say("  DRY RUN - nothing will be written");

  const plugins = readPlugins();
  if (plugins.length === 0) fail("plugins/ is empty");
  say("  plugins     " + plugins.length + " (" + plugins.join(", ") + ")");

  if (UNINSTALL) return uninstall(grok, plugins);

  step("1. installing the LSP proxy");
  if (DRY) {
    say("  would write " + PROXY_DEST);
  } else {
    fs.mkdirSync(GROK_HOME, { recursive: true });
    fs.copyFileSync(path.join(HERE, "lib", "lsp-open-proxy.js"), PROXY_DEST);
    ok("proxy -> " + PROXY_DEST);
  }

  step("2. staging the plugins");
  if (!DRY) fs.rmSync(STAGING, { recursive: true, force: true });
  for (const name of plugins) {
    const src = path.join(HERE, "plugins", name);
    const dest = path.join(STAGING, name);
    if (DRY) {
      say("  would stage " + name);
      continue;
    }
    copyTree(src, dest, {
      "@FORMAT_ENTRY@": HOOK_ENTRY,
      "@PROXY@": PROXY_FOR_JSON,
    });
    ok("staged " + name);
  }

  step("3. registering the marketplace");
  const run = (cargs) => {
    if (DRY) {
      say("  would run: grok " + cargs.join(" "));
      return { status: 0, stdout: "", stderr: "" };
    }
    const r = spawnSync(grok, cargs, { encoding: "utf8" });
    if (r.status !== 0) {
      warn("grok " + cargs.join(" ") + " exited " + r.status);
      const out = ((r.stderr || "") + (r.stdout || "")).trim();
      if (out) say("    " + out.split("\n").slice(0, 6).join("\n    "));
    }
    return r;
  };

  // Adding an already-present source is harmless on the versions that report it
  // as an error, so the exit status is reported but not treated as fatal.
  run(["plugin", "marketplace", "add", STAGING]);
  ok("marketplace: " + STAGING);

  step("4. installing plugins");
  for (const name of plugins) {
    const r = run(["plugin", "install", name, "--trust"]);
    if (r.status === 0 && !DRY) {
      const line = (r.stdout || "").trim().split("\n")[0] || "installed";
      ok(name.padEnd(20) + line);
    } else if (DRY) {
      ok(name);
    }
  }

  step("5. enabling LSP tools");
  enableLspTools();

  step("Done.");
  say("");
  say("  Restart Grok Build so it picks up the new plugins, then check /hooks");
  say("  and edit a file in any supported language - it should format on save.");
  say("");
  say("  Supported: Rust, Python, Go, C/C++, TypeScript/JavaScript, Zig, AssemblyScript");
  say("  Each plugin's setup skill lists the toolchain it needs.");
  say("");
}

// ---------------------------------------------------------------- uninstall --
function uninstall(grok, plugins) {
  step("Removing plugins");
  for (const name of plugins) {
    const r = spawnSync(grok, ["plugin", "uninstall", name, "--confirm"], { encoding: "utf8" });
    if (r.status === 0) ok(name);
    else warn(name + " - not removed (may not be installed)");
  }
  step("Removing staged files");
  if (!DRY) {
    fs.rmSync(STAGING, { recursive: true, force: true });
    try {
      fs.rmSync(PROXY_DEST, { force: true });
    } catch {
      /* already gone */
    }
  }
  ok(STAGING);
  say("");
  say("  Your toolchains and any files they produced are untouched.");
  say("  The [features] lsp_tools flag was left as it was.");
  say("");
}

// ------------------------------------------------------------ lsp_tools flag --
function enableLspTools() {
  const configPath = path.join(GROK_HOME, "config.toml");
  if (!fs.existsSync(configPath)) {
    warn("no config.toml at " + configPath + " - skipping");
    return;
  }
  let text = fs.readFileSync(configPath, "utf8");
  if (/^\s*lsp_tools\s*=/m.test(text)) {
    ok("lsp_tools already present");
    return;
  }
  if (DRY) {
    say("  would append [features] lsp_tools = true");
    return;
  }

  // Append a new table at the end. TOML is order-independent, and appending
  // cannot disturb anything already in the file.
  const backup = configPath + ".bak-lsp-toolkit";
  if (!fs.existsSync(backup)) fs.copyFileSync(configPath, backup);

  const addition = "\n[features]\nlsp_tools = true\n";
  text = text.replace(/\s*$/, "\n") + addition;

  // Write atomically so a reader never sees a half-written config.
  const tmp = configPath + ".tmp-lsp-toolkit";
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, configPath);
  ok("lsp_tools = true added (backup: " + path.basename(backup) + ")");
}

install();
