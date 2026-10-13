// The probe layer: pure functions that turn a resolver result into a report.
//
// Nothing here spawns a process or touches the filesystem. The caller passes in a
// resolve() function, so the same logic is testable against a fake resolver that
// reports a missing binary, which is the case that is hardest to exercise on a
// machine where everything is installed.

import { LANGUAGE_TABLE } from "./languages.mjs";

// resolve: (binary) => { found: boolean, path?: string, version?: string }
//
// Returns one entry per language, always with the same shape. A missing binary is
// data, never an exception.
export function probe(resolve) {
	const languages = [];

	for (const lang of LANGUAGE_TABLE) {
		const entry = {
			id: lang.id,
			label: lang.label,
			trap: lang.trap,
			projectFile: lang.projectFile || null,
			pinCommand: lang.pinCommand || null,
			complete: true,
		};

		const parts = [
			["server", lang.server],
			["formatter", lang.formatter],
			["toolchain", lang.toolchain],
			["linter", lang.linter],
		];

		for (const [role, spec] of parts) {
			if (!spec) {
				entry[role] = {
					applicable: false,
					reason: "no separate tool for this role",
				};
				continue;
			}
			const r = resolve(spec.binary, spec.versionArgs, spec);
			entry[role] = {
				applicable: true,
				binary: spec.binary,
				present: r.found,
				path: r.path || null,
				version: r.version || null,
			};
			if (!r.found) entry.complete = false;
		}

		entry.installCommand = lang.install[process.platform] || lang.install.linux;
		// Copied through so install_missing can report the Windows launcher step
		// without reaching back into the language table.
		if (lang.needsWindowsLauncher) entry.needsWindowsLauncher = true;
		languages.push(entry);
	}

	return {
		platform: process.platform,
		generatedFor: "lsp-lint-toolkit",
		languageCount: languages.length,
		completeCount: languages.filter((l) => l.complete).length,
		missingCount: languages.filter((l) => !l.complete).length,
		languages,
	};
}

// The subset the installer acts on. Only absent, applicable tools, so a fully
// installed machine produces an empty plan and exits 0.
export function installPlan(report) {
	const steps = [];
	for (const lang of report.languages) {
		const absent = [];
		for (const role of ["server", "formatter", "linter", "toolchain"]) {
			const t = lang[role];
			if (t && t.applicable && !t.present) absent.push(role + ":" + t.binary);
		}
		if (absent.length > 0) {
			steps.push({
				language: lang.id,
				label: lang.label,
				absent,
				command: lang.installCommand,
				pinCommand: lang.pinCommand,
				needsWindowsLauncher: Boolean(
					lang.needsWindowsLauncher && report.platform === "win32",
				),
			});
		}
	}
	return { platform: report.platform, stepCount: steps.length, steps };
}

// Version skew is a real failure mode: a standalone clangd at 23.x and a toolchain
// clang-format at 17.x can disagree about what parses.
export function doctor(report) {
	const findings = [];

	for (const lang of report.languages) {
		if (!lang.complete) {
			const missing = [];
			for (const role of ["server", "formatter", "linter", "toolchain"]) {
				const t = lang[role];
				if (t && t.applicable && !t.present) missing.push(role);
			}
			findings.push({
				severity: "error",
				language: lang.id,
				message:
					lang.label + " is incomplete. Missing: " + missing.join(", ") + ".",
				remedy: lang.installCommand,
			});
		}

		// Compare major versions only where the server and the formatter share a
		// release line. clangd and clang-format are both LLVM, so 23.x versus 17.x
		// means they can genuinely disagree about valid syntax. Every other pair in
		// this table (typescript-language-server versus biome, pyright versus ruff,
		// gopls versus gofmt) versions independently, and comparing their majors only
		// produces noise. That is why this check is gated on the language id.
		const skewApplies = lang.id === "cpp" || lang.id === "c";
		const s = lang.server;
		const f = lang.formatter;
		if (
			skewApplies &&
			s &&
			f &&
			s.applicable &&
			f.applicable &&
			s.version &&
			f.version
		) {
			const sm = /(\d+)\./.exec(s.version);
			const fm = /(\d+)\./.exec(f.version);
			if (sm && fm && sm[1] !== fm[1]) {
				findings.push({
					severity: "warn",
					language: lang.id,
					message:
						lang.label +
						" has a major version skew: server " +
						s.version +
						", formatter " +
						f.version +
						". They can disagree about valid syntax.",
					remedy:
						"Align the two, or accept that formatting may differ from what the server parses.",
				});
			}
		}
	}

	const cpp = report.languages.find((l) => l.id === "cpp");
	if (cpp && cpp.server && cpp.server.present) {
		findings.push({
			severity: "info",
			language: "cpp",
			message:
				"clangd returns symbols without compile_commands.json. That file is needed for accurate include resolution only.",
		});
	}

	return { platform: report.platform, findingCount: findings.length, findings };
}
