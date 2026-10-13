// Client test: drives the real shipped server over stdio and asserts the contract.
//
// This is not a re-implementation of the server. It spawns `node server.mjs`, speaks
// the protocol to it, and checks what comes back. If the server is broken, these fail.
//
// Usage: node mcp/test/client.mjs [--server <path>]
//
// Checks:
//   1. initialize answers within 2 seconds with no project present
//   2. tools/list advertises all five tools
//   3. probe_toolchains returns one entry per language, each with a presence flag,
//      and a version string when present
//   4. absent tools are reported as data, not as an error
//   5. doctor and install_missing and language_for_file all answer
//   6. the whole sequence is identical across two runs

import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SERVER = path.join(HERE, "..", "server.mjs");

const argIdx = process.argv.indexOf("--server");
const SERVER =
	argIdx > -1 ? path.resolve(process.argv[argIdx + 1]) : DEFAULT_SERVER;

// Eight, not seven: C and C++ share the clangd and clang-format binaries but are
// distinct language ids, because .c means C source and .C means C++ source.
const LANGUAGE_COUNT = 8;
const EXPECTED_TOOLS = [
	"probe_toolchains",
	"install_missing",
	"doctor",
	"readme",
	"language_for_file",
];

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
	console.log((ok ? "PASS " : "FAIL ") + name + (detail ? "  " + detail : ""));
	ok ? pass++ : fail++;
};

function startServer() {
	const p = spawn(process.execPath, [SERVER], {
		stdio: ["pipe", "pipe", "inherit"],
		windowsHide: true,
	});
	const pending = new Map();
	let buf = "";

	p.stdout.setEncoding("utf8");
	p.stdout.on("data", (chunk) => {
		buf += chunk;
		let nl;
		while ((nl = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, nl).trim();
			buf = buf.slice(nl + 1);
			if (!line) continue;
			let msg;
			try {
				msg = JSON.parse(line);
			} catch {
				continue;
			}
			if (msg.id !== undefined && pending.has(msg.id)) {
				pending.get(msg.id)(msg);
				pending.delete(msg.id);
			}
		}
	});

	function request(method, params, timeoutMs = 90000) {
		const id = Math.floor(Math.random() * 1e9);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error(method + " timed out after " + timeoutMs + "ms"));
			}, timeoutMs);
			pending.set(id, (msg) => {
				clearTimeout(timer);
				resolve(msg);
			});
			p.stdin.write(
				JSON.stringify({ jsonrpc: "2.0", id, method, params: params || {} }) +
					"\n",
			);
		});
	}

	// A notification carries no id, so the server never replies. Sending it through
	// request() would wait for a response that cannot come, which is exactly what
	// the first version of this test did and why it hung on "initialized".
	function notify(method, params) {
		p.stdin.write(
			JSON.stringify({ jsonrpc: "2.0", method, params: params || {} }) + "\n",
		);
	}

	return { p, request, notify };
}

function toolPayload(res) {
	const text = res?.result?.content?.[0]?.text;
	if (typeof text !== "string") return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

async function runOnce(label) {
	const { p, request, notify } = startServer();
	const ok = { label };

	try {
		// 1. initialize, timed, with no project present.
		const t0 = Date.now();
		const init = await request(
			"initialize",
			{
				protocolVersion: "2024-11-05",
				capabilities: {},
				clientInfo: { name: "client-test", version: "1.0.0" },
			},
			2000,
		);
		const initMs = Date.now() - t0;
		check(
			label + ": initialize answers within 2s",
			initMs < 2000,
			initMs + "ms",
		);
		check(
			label + ": serverInfo names the server",
			init?.result?.serverInfo?.name === "lsp-lint-toolkit",
			init?.result?.serverInfo?.name || "none",
		);

		notify("initialized", {});

		// 2. tools/list.
		const list = await request("tools/list", {});
		const names = (list?.result?.tools || []).map((t) => t.name).sort();
		check(
			label + ": tools/list advertises all five tools",
			EXPECTED_TOOLS.every((t) => names.includes(t)),
			names.join(","),
		);

		// 3. probe_toolchains shape.
		const probe = toolPayload(
			await request("tools/call", { name: "probe_toolchains", arguments: {} }),
		);
		check(
			label + ": probe returns a report",
			Boolean(probe),
			probe ? "" : "null payload",
		);
		if (probe) {
			check(
				label + ": probe has one entry per language",
				Array.isArray(probe.languages) &&
					probe.languages.length === LANGUAGE_COUNT,
				"count=" + (probe.languages ? probe.languages.length : 0),
			);
			const wellFormed = probe.languages.every(
				(l) =>
					typeof l.id === "string" &&
					typeof l.complete === "boolean" &&
					l.server &&
					typeof l.server.applicable === "boolean" &&
					l.formatter &&
					typeof l.formatter.applicable === "boolean" &&
					typeof l.trap === "string" &&
					l.trap.length > 0,
			);
			check(label + ": every entry has a presence flag and a trap", wellFormed);

			// 4. present tools carry a version, absent ones carry null and no throw.
			const versionOk = probe.languages.every((l) => {
				if (l.formatter.applicable && l.formatter.present) {
					return (
						typeof l.formatter.version === "string" &&
						l.formatter.version.length > 0
					);
				}
				return l.formatter.version === null;
			});
			check(
				label + ": present formatters carry a version, absent carry null",
				versionOk,
			);
			check(
				label + ": completeCount plus missingCount equals languageCount",
				probe.completeCount + probe.missingCount === probe.languageCount,
				probe.completeCount +
					"+" +
					probe.missingCount +
					" of " +
					probe.languageCount,
			);
			ok.probe = probe;
		}

		// 5. the remaining tools answer.
		const install = toolPayload(
			await request("tools/call", { name: "install_missing", arguments: {} }),
		);
		check(
			label + ": install_missing answers with a plan",
			Boolean(install) && typeof install.nothingToDo === "boolean",
			install ? "steps=" + install.plan.stepCount : "null",
		);

		const doc = toolPayload(
			await request("tools/call", {
				name: "doctor",
				arguments: { checkGrokConfig: true, checkCommandCode: true },
			}),
		);
		check(
			label + ": doctor answers with findings",
			Boolean(doc) && Array.isArray(doc.findings),
			doc ? "findings=" + doc.findingCount : "null",
		);

		const lang = toolPayload(
			await request("tools/call", {
				name: "language_for_file",
				arguments: { filePath: "src/main.rs" },
			}),
		);
		check(
			label + ": language_for_file maps .rs to rust",
			lang && lang.ok === true && lang.language === "rust",
			lang ? lang.language : "null",
		);

		// The uppercase mapping is the one that regressed before, so assert it here.
		const langC = toolPayload(
			await request("tools/call", {
				name: "language_for_file",
				arguments: { filePath: "widget.C" },
			}),
		);
		check(
			label + ": language_for_file maps .C to cpp",
			langC && langC.language === "cpp",
			langC ? langC.language : "null",
		);

		const rm = toolPayload(
			await request("tools/call", { name: "readme", arguments: {} }),
		);
		check(
			label + ": readme answers",
			Boolean(rm) && (rm.ok === true || typeof rm.summary === "string"),
			rm
				? rm.ok
					? "markdown " + rm.markdown.length + " chars"
					: "summary only"
				: "null",
		);
	} finally {
		try {
			p.kill();
		} catch {}
	}

	return ok;
}

const first = await runOnce("run1");
const second = await runOnce("run2");

// 6. identical structure across runs, so the probe is not order dependent.
if (first.probe && second.probe) {
	const shapeA = first.probe.languages
		.map((l) => l.id + ":" + l.complete + ":" + l.formatter.present)
		.join("|");
	const shapeB = second.probe.languages
		.map((l) => l.id + ":" + l.complete + ":" + l.formatter.present)
		.join("|");
	check(
		"both runs report the same shape",
		shapeA === shapeB,
		shapeA === shapeB ? "identical" : "DIFFERS",
	);
}

console.log("");
console.log("TOTAL pass=" + pass + " fail=" + fail);
process.exit(fail === 0 ? 0 : 1);
