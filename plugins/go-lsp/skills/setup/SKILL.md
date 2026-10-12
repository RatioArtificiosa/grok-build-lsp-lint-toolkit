---
name: setup
description: Install and verify the Go toolchain for this plugin
---

# Go setup

```bash
go install golang.org/x/tools/gopls@latest

# verify (gofmt ships with the Go toolchain)
gopls version
gofmt -h
```

## Notes

- gopls works best from inside a Go module - a directory with a go.mod.
- A newly created file outside any module will report 'no packages found', which is expected rather than a fault.

## Enable LSP tools in Grok Build

```toml
# ~/.grok/config.toml
[features]
lsp_tools = true
```

Without that flag the language server runs but nothing it reports reaches the model.