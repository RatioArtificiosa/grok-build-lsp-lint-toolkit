@echo off
rem Grok Build PostToolUse entry point for Windows.
rem
rem The harness spawns this file directly with CreateProcess and no shell, so the
rem command named in hooks.json has to be a real Win32 executable. A .sh is not -
rem that is why this wrapper exists next to format.sh rather than instead of it.
rem
rem Everything below the node call is identical on every platform; only the way
rem the process is started differs.
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo format hook: node is not on PATH - install Node.js to enable formatting 1>&2
  exit /b 0
)
node "%~dp0format.js"
rem A hook must never fail the tool call.
exit /b 0
