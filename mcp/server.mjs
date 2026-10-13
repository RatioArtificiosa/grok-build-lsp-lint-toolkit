#!/usr/bin/env node

// The MCP toolchain server.
//
// Purpose: let an agent check for, and repair, the language toolchains this toolkit
// depends on, in the same turn where it noticed the gap. A skill can only advise, and
// a PreToolUse hook can only allow or deny, so neither can install anything and keep
// going. An MCP server exposes tools the model calls.
//
// Protocol: MCP over stdio, newline-delimited JSON, the subset Claude Code and
// CommandCode both speak. No runtime dependencies beyond Node 18.
//
// Tools:
//   probe_toolchains  what is installed, resolved paths, versions, and the trap per language
//   install_missing   the exact commands to run, plus the Windows launcher step
//   doctor            findings, including version skew between a server and its formatter
//   readme            the install instructions, so no network call is needed
//
// Rules this file honours:
//   - never throws on a missing binary, a missing binary is data
//   - shell:true only on Windows and only for .cmd/.bat, never on interpolated input
//   - every spawn is capped, and partial output is surfaced on timeout
//   - writes only inside a directory the caller names
//   - exit 0 when there is nothing to do

import fs from "fs";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";
import { makeResolver, run, which, writeWithin } from "./lib/io.mjs";
import { LANGUAGE_TABLE, languageForFile } from "./lib/languages.mjs";
import { doctor, installPlan, probe } from "./lib/probe.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

function toolProbe() {
	const resolver = makeResolver();
	return probe(resolver);
}

function toolInstall() {
	const resolver = makeResolver();
	const report = probe(resolver);
	const plan = installPlan(report);

	return {
		platform: report.platform,
		nothingToDo: plan.stepCount === 0,
		plan,
		// The Windows launcher is the actual fix for the upstream spawn bug. npm installs
		// typescript-language-server as .cmd and .ps1 shims and never as a .exe, and a
		// no-shell spawn cannot resolve it.
		windowsLauncher:
			report.platform === "win32"
				? {
						needed: plan.steps.some((s) => s.needsWindowsLauncher),
						source: path.join(HERE, "launcher.cs"),
						compiler:
							"C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe",
						outName: "typescript-language-server.exe",
						outDir: path.join(process.env.APPDATA || "", "npm"),
						command:
							"csc /target:exe /nologo /optimize+ /out:<npmdir>\\typescript-language-server.exe launcher.cs",
						why: "Grok and Claude Code both spawn language servers with uv_spawn and no shell. On Windows that resolves only .exe, and npm never installs a .exe for this server.",
					}
				: null,
		verify: plan.steps.map((s) => ({
			language: s.language,
			// The lookup cannot miss today because steps are built from this same
			// table, but a missing entry must report null rather than throw, or one
			// bad id takes down the whole install report.
			check:
				(LANGUAGE_TABLE.find((l) => l.id === s.language) || {}).trap || null,
		})),
	};
}

function toolDoctor(extra) {
	const resolver = makeResolver();
	const report = probe(resolver);
	const findings = doctor(report).findings;

	// Optional environment checks, so one call answers "is my setup actually wired".
	const opts = extra && typeof extra === "object" ? extra : {};
	if (opts.checkGrokConfig) {
		const cfg = path.join(
			process.env.HOME || process.env.USERPROFILE || "",
			".grok",
			"config.toml",
		);
		const ok = fs.existsSync(cfg);
		findings.push({
			severity: ok ? "info" : "warn",
			language: "grok",
			message: ok
				? "Grok config found. Confirm each lsp plugin points at the proxy rather than the server binary directly."
				: "No Grok config found at the default location. If Grok is installed elsewhere, point this at it.",
		});
	}
	if (opts.checkCommandCode) {
		// The hook entry point is format.cmd on Windows and format.sh elsewhere.
		// Checking for the wrong one would report a present hook as missing.
		const hookName = process.platform === "win32" ? "format.cmd" : "format.sh";
		const cc = path.join(
			process.env.HOME || process.env.USERPROFILE || "",
			".commandcode",
			"hooks",
			hookName,
		);
		const ok = fs.existsSync(cc);
		findings.push({
			severity: ok ? "info" : "warn",
			language: "commandcode",
			message: ok
				? "CommandCode format hook is present."
				: "No CommandCode format hook found. Copy hooks/format.* into ~/.commandcode/hooks/ and add a PostToolUse entry under matcher write|edit.",
		});
	}

	return {
		platform: report.platform,
		completeCount: report.completeCount,
		missingCount: report.missingCount,
		findingCount: findings.length,
		findings,
	};
}

function toolReadme() {
	const readme = path.join(HERE, "..", "README.md");
	if (!fs.existsSync(readme)) {
		return {
			ok: false,
			message: "README.md not found next to the server.",
			summary:
				"Install the language server and formatter for your stack, then point each harness at the proxy for .ts and at the launcher on Windows.",
		};
	}
	return { ok: true, markdown: fs.readFileSync(readme, "utf8") };
}

// Used by the client test and by anyone wiring this in: the extension map, so an
// agent can answer "which language is this file" without guessing.
function toolLanguageFor(filePath) {
	if (typeof filePath !== "string" || !filePath.length) {
		return { ok: false, error: "filePath is required" };
	}
	return { ok: true, filePath, language: languageForFile(filePath) };
}

const TOOLS = [
	{
		name: "probe_toolchains",
		description:
			"Report, per language, whether the language server and formatter are installed, their resolved paths and versions, and the known trap for that language. A missing binary is reported as data, never as an error.",
		inputSchema: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
		handler: () => toolProbe(),
	},
	{
		name: "install_missing",
		description:
			"Return the exact commands to install whatever probe_toolchains found missing, plus the Windows .exe launcher step for typescript-language-server. Read-only: nothing is executed, so a probe can never mutate a machine.",
		inputSchema: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
		handler: () => toolInstall(),
	},
	{
		name: "doctor",
		description:
			"Combined health report: incomplete languages, major version skew between a server and its formatter, and optional wiring checks for Grok and CommandCode.",
		inputSchema: {
			type: "object",
			properties: {
				checkGrokConfig: { type: "boolean" },
				checkCommandCode: { type: "boolean" },
			},
			additionalProperties: false,
		},
		handler: (args) => toolDoctor(args),
	},
	{
		name: "readme",
		description:
			"Return the toolkit README so install instructions are available without a network call.",
		inputSchema: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
		handler: () => toolReadme(),
	},
	{
		name: "language_for_file",
		description: "Map a file path to the language id this toolkit uses for it.",
		inputSchema: {
			type: "object",
			properties: { filePath: { type: "string" } },
			required: ["filePath"],
			additionalProperties: false,
		},
		handler: (args) => toolLanguageFor(args && args.filePath),
	},
];

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

function send(obj) {
	process.stdout.write(JSON.stringify(obj) + "\n");
}

function toolResult(id, payload) {
	send({
		jsonrpc: "2.0",
		id,
		result: {
			content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
		},
	});
}

function toolError(id, message) {
	send({ jsonrpc: "2.0", id, error: { code: -32603, message } });
}

function handle(msg) {
	const { id, method, params } = msg;

	if (method === "initialize") {
		send({
			jsonrpc: "2.0",
			id,
			result: {
				protocolVersion: "2024-11-05",
				capabilities: { tools: {} },
				serverInfo: { name: "lsp-lint-toolkit", version: "1.0.0" },
			},
		});
		return;
	}

	if (method === "initialized" || method === "notifications/initialized")
		return;

	if (method === "tools/list") {
		send({
			jsonrpc: "2.0",
			id,
			result: {
				tools: TOOLS.map((t) => ({
					name: t.name,
					description: t.description,
					inputSchema: t.inputSchema,
				})),
			},
		});
		return;
	}

	if (method === "tools/call") {
		const name = params && params.name;
		const args = (params && params.arguments) || {};
		const tool = TOOLS.find((t) => t.name === name);
		if (!tool) {
			toolError(id, "unknown tool: " + name);
			return;
		}
		try {
			toolResult(id, tool.handler(args));
		} catch (e) {
			toolError(id, String((e && e.message) || e));
		}
		return;
	}

	if (method === "ping") {
		send({ jsonrpc: "2.0", id, result: {} });
		return;
	}

	// Unknown notification: ignore. Unknown request: answer so the client does not hang.
	if (id !== undefined && id !== null) {
		send({
			jsonrpc: "2.0",
			id,
			error: { code: -32601, message: "method not found: " + method },
		});
	}
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on("line", (line) => {
	const trimmed = line.trim();
	if (!trimmed) return;
	let msg;
	try {
		msg = JSON.parse(trimmed);
	} catch {
		return;
	}
	try {
		handle(msg);
	} catch (e) {
		if (msg && msg.id !== undefined && msg.id !== null) {
			toolError(msg.id, String((e && e.message) || e));
		}
	}
});

// When stdin closes the client is gone, but process.exit() would discard whatever
// stdout is still queued. Setting the code and returning lets Node drain first,
// which is the same reason the LSP proxy never calls process.exit() on server death.
rl.on("close", () => {
	process.exitCode = 0;
});

// A single readable line on stderr, and only for a real internal fault.
process.on("uncaughtException", (e) => {
	process.stderr.write(
		"lsp-lint-toolkit: " + String((e && e.message) || e) + "\n",
	);
});
