---
name: setup
description: Install and verify the TypeScript / JavaScript toolchain for this plugin
---

# TypeScript / JavaScript setup

```bash
npm install --global @biomejs/biome typescript-language-server typescript@5

# verify
biome --version
typescript-language-server --version
```

## Notes

- **Pin TypeScript to the 5.x line.** 	ypescript-language-server drives the compiler through lib/tsserver.js, and TypeScript 7 removed that file. A project with TypeScript 7 installed fails with a message about a *missing* installation rather than a wrong version, which is easy to misread. Use 
pm install --save-dev typescript@5 per project.
- Biome is the formatter. If a project uses Prettier instead, point the hook at it by editing ormat.json.

## Enable LSP tools in Grok Build

```toml
# ~/.grok/config.toml
[features]
lsp_tools = true
```

Without that flag the language server runs but nothing it reports reaches the model.