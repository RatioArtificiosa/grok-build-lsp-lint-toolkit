#!/usr/bin/env sh
# Grok Build PostToolUse entry point for macOS and Linux.
#
# The harness spawns this file directly, so it must be executable:
#   chmod +x format.sh
# The installer does that for you.
#
# This is the twin of format.cmd. Windows cannot exec a .sh, so the two files
# exist side by side and hooks.json names whichever one the platform can run.

if ! command -v node >/dev/null 2>&1; then
  echo "format hook: node is not on PATH - install Node.js to enable formatting" >&2
  exit 0
fi

# exec, so no extra shell lingers for the lifetime of the formatter.
exec node "$(dirname "$0")/format.js"
