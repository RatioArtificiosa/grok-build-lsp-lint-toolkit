// Grok Build PostToolUse hook: format the file that was just written.
//
// This runs on macOS, Linux and Windows. The harness spawns the platform entry
// point next to this file - `format.cmd` on Windows, `format.sh` elsewhere -
// and both simply exec `node format.js` with the event on stdin.
//
// Sibling files:
//   format.cmd   Windows entry point
//   format.sh    macOS / Linux entry point
//   format.json  { "extensions": [...], "commands": [ { "command", "args", "shell" } ] }
//
// `commands` runs in order, so a plugin can lint then format, the way `ruff
// check --fix` followed by `ruff format` does.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

// The harness puts the edited path in toolInput. Cover the key names seen in
// the wild so this keeps working if the envelope changes.
function extractPath(event) {
  const ti = event.toolInput || event.tool_input || event.input || {};
  let p = ti.file_path || ti.filePath || ti.path || ti.file || "";
  if (!p && Array.isArray(ti.edits) && ti.edits.length) {
    const e0 = ti.edits[0] || {};
    p = e0.file_path || e0.filePath || e0.path || "";
  }
  return typeof p === "string" ? p : "";
}

function main() {
  const dir = __dirname;

  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(dir, "format.json"), "utf8"));
  } catch (err) {
    console.error("format.json unreadable: " + err.message);
    return 0;
  }

  const raw = readStdin();
  if (!raw.trim()) return 0;

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return 0;
  }

  const file = extractPath(event);
  if (!file) return 0;

  const ext = path.extname(file).toLowerCase();
  const wanted = (cfg.extensions || []).map((e) => e.toLowerCase());
  if (!wanted.includes(ext)) return 0;

  if (!fs.existsSync(file)) return 0;

  const steps = cfg.commands || (cfg.command ? [{ command: cfg.command, args: cfg.args }] : []);

  // Run from the file's own directory so tools that walk upward for their config
  // (biome.json, eslint.config.*, .rustfmt.toml, asconfig.json) find it.
  const cwd = path.dirname(file);

  for (const step of steps) {
    if (!step || !step.command) continue;
    const res = spawnSync(step.command, (step.args || []).concat([file]), {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      // Node 20+ refuses to spawn .cmd/.bat without a shell (CVE-2024-27980),
      // which is what npm installs are on Windows.
      shell: step.shell === true,
    });
    if (res.error) {
      console.error(step.command + " could not run: " + res.error.message);
      continue;
    }
    if (res.status !== 0) {
      const out = (res.stderr || res.stdout || Buffer.from("")).toString().trim();
      console.error(step.command + " exited " + res.status + (out ? ": " + out.split("\n")[0] : ""));
    }
  }
  return 0;
}

// A hook must never fail the tool call.
try {
  process.exitCode = main();
} catch (err) {
  console.error("hook error: " + (err && err.message));
  process.exitCode = 0;
}
