---
name: setup
description: Install and verify the Zig toolchain for this plugin
---

# Zig setup

```bash
# install zig from https://ziglang.org/download/
# download the zls build that matches your zig version exactly (they are released in pairs)

# verify - the two versions must agree
zig version
zls --version
```

## Notes

- **zls must match your zig version.** zls releases track specific zig releases - zls 0.16.x speaks to zig 0.16.x and nothing else. Installing the newest zig alongside an older zls produces a server that starts and then answers nothing.
- zls is often a release behind zig. If your zig is newer than any published zls, use the previous zig release so the pair matches.

## Enable LSP tools in Grok Build

```toml
# ~/.grok/config.toml
[features]
lsp_tools = true
```

Without that flag the language server runs but nothing it reports reaches the model.