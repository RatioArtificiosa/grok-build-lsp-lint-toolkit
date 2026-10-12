---
name: setup
description: Install and verify the Rust toolchain for this plugin
---

# Rust setup

```bash
rustup component add rust-analyzer rustfmt clippy

# verify
rust-analyzer --version
rustfmt --version
cargo clippy --version
```

## Notes

- rust-analyzer loads its crate graph from Cargo.toml, so open a workspace root, not a lone file.
- Clippy is driven through the language server (initializationOptions.check.command) rather than a separate hook, so its diagnostics arrive with the rest of the LSP feedback.

## Enable LSP tools in Grok Build

```toml
# ~/.grok/config.toml
[features]
lsp_tools = true
```

Without that flag the language server runs but nothing it reports reaches the model.