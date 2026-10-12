---
name: setup
description: Install and verify the C / C++ toolchain for this plugin
---

# C / C++ setup

```bash
# install the LLVM toolchain for your platform, or use the standalone clangd build
#   macOS          brew install llvm
#   Debian/Ubuntu  sudo apt install clangd clang-format
#   Windows        winget install LLVM.LLVM

# verify
clangd --version
clang-format --version
```

## Notes

- clangd gives formatting and outlines out of the box, but accurate include resolution and cross-file navigation need a compile_commands.json at the project root - CMake writes one with -DCMAKE_EXPORT_COMPILE_COMMANDS=ON.
- clang-tidy runs through clangd, so it needs no separate hook.

## Enable LSP tools in Grok Build

```toml
# ~/.grok/config.toml
[features]
lsp_tools = true
```

Without that flag the language server runs but nothing it reports reaches the model.