---
name: setup
description: Install and verify the Python toolchain for this plugin
---

# Python setup

```bash
pip install pyright ruff

# verify
pyright --version
ruff --version
```

## Notes

- The hook runs ruff check --fix and then ruff format, so lint fixes and formatting both land in one pass.
- Pyright resolves imports from the interpreter and any configured virtual environment, so run it inside the environment your project uses.

## Enable LSP tools in Grok Build

```toml
# ~/.grok/config.toml
[features]
lsp_tools = true
```

Without that flag the language server runs but nothing it reports reaches the model.
