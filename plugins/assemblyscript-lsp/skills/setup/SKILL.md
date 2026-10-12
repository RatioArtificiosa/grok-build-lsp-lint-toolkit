---
name: setup
description: Install and verify the AssemblyScript toolchain for this plugin
---

# AssemblyScript setup

```bash
# ESLint runs through npx, so nothing global is required
# the project needs its own eslint.config.js, which a real AssemblyScript project has
npm install --save-dev eslint

# verify inside the project
npx eslint --version
```

## Notes

- **This plugin deliberately ships no language server.** AssemblyScript compiles from .ts, so it would claim the same extension as ts-lsp - and a client that refuses ambiguous extensions would then treat .ts as configured for nobody. Two plugins claiming one extension is worse than one plugin claiming it well, so this plugin carries only the formatter and ts-lsp owns the language server.
- ESLint is a linter rather than a formatter: it applies fixable rule violations and will not reindent code the way a formatter does.
- The hook calls ESLint through npx, which prefers the project's own copy over any global install - so a project pinned to an older ESLint is linted with the version it expects.

## Enable LSP tools in Grok Build

```toml
# ~/.grok/config.toml
[features]
lsp_tools = true
```

Without that flag the language server runs but nothing it reports reaches the model.
