// The I/O layer: the only place that spawns a process.
//
// Shell rules, and why they are what they are:
//  - shell:true is used only on Windows, and only when the target is a .cmd or .bat.
//    Node 18 and later refuse to spawn those without a shell (CVE-2024-27980).
//  - Everywhere else, shell:false, and no user input is ever interpolated into a
//    command string. Args are passed as an array so the OS does the quoting.
//  - A .ps1 target is never spawned. PowerShell shims are not directly executable
//    under CreateProcess, which is why this toolkit ships a real .exe launcher.

import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";

const DEFAULT_TIMEOUT_MS = 8000;

// True when a resolved path ends in a batch extension that needs shell mediation.
function needsShell(target) {
	if (process.platform !== "win32") return false;
	return /\.(cmd|bat)$/i.test(target);
}

// Turn a possibly-relative command into something spawnSync can resolve.
function resolveTarget(command) {
	if (command.includes("/") || command.includes("\\")) {
		return path.resolve(command);
	}
	return command;
}

// Run a command and return stdout, stderr, status and whether it timed out.
// Never throws. A timeout returns the partial output, because that is usually the
// useful part.
export function run(command, args, options = {}) {
	const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
	const cwd = options.cwd || process.cwd();
	const target = resolveTarget(command);
	const forceShell = options.shell === true;
	const useShell = forceShell || needsShell(target);

	// With shell:true, cmd.exe splits an unquoted path on spaces, so a resolved
	// path like C:\Program Files\nodejs\npx.cmd fails as 'C:\Program' not found.
	// Quote it here rather than at any call site, so every caller is safe.
	const spawnTarget =
		useShell && /[\s]/.test(target) && !/^".*"$/.test(target)
			? `"${target}"`
			: target;

	// Under a shell, an argument containing whitespace would split into two, so
	// quote those the same way. Without a shell the OS receives the argv array
	// verbatim and metacharacters are inert, which is why shell:false stays the
	// default everywhere. No caller passes user input today, and this keeps it safe
	// if one ever does.
	const spawnArgs = (args || []).map((a) =>
		useShell && /[\s"]/.test(a) ? `"` + a.replace(/"/g, '\\"') + `"` : a,
	);

	const result = spawnSync(spawnTarget, spawnArgs, {
		cwd,
		encoding: "utf8",
		windowsHide: true,
		timeout,
		shell: useShell,
		maxBuffer: 4 * 1024 * 1024,
	});

	if (result.error) {
		// A timeout surfaces as an error with code ETIMEDOUT, and spawnSync keeps
		// whatever the child had already written. Return that partial output rather
		// than discarding it, because it is usually the useful part. Anything else
		// is a real spawn failure.
		// Note: an externally delivered SIGTERM also sets result.signal, so the
		// timeout flag keys off the error code and not the signal.
		const timedOut = result.error.code === "ETIMEDOUT";
		return {
			ok: false,
			status: result.status ?? null,
			stdout: result.stdout || "",
			stderr: result.stderr || String(result.error.message || result.error),
			timedOut,
			shell: forceShell || needsShell(target),
		};
	}

	return {
		ok: true,
		status: result.status,
		stdout: result.stdout || "",
		stderr: result.stderr || "",
		// Timeouts return through the error branch above, so reaching here means the
		// process ended on its own. A signal here would be externally delivered, and
		// that is not a timeout.
		timedOut: false,
		shell: forceShell || needsShell(target),
	};
}

// Find a binary without running it, so a probe does not pay a spawn for a tool that
// is only going to be reported as present.
//
// npm shims complicate this: on Windows the extensionless entry is a sh script, and
// the .cmd is what actually runs. So a bare name is looked up by trying the common
// extensions through the OS resolver rather than trusting a single hit.
export function which(command) {
	if (!command) return null;

	// A command containing a separator is a path, so check it directly. It must be
	// a file: existsSync is true for directories too, and a directory is not
	// runnable. A bare name skips this entirely and goes to the PATH search below,
	// so a file in the working directory that happens to share the name can never
	// shadow the real binary.
	if (/[/\\]/.test(command)) {
		const target = path.resolve(command);
		try {
			if (fs.statSync(target).isFile()) return target;
		} catch {
			return null;
		}
		return null;
	}

	const paths = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
	const exts =
		process.platform === "win32" ? [".exe", ".cmd", ".bat", ".ps1", ""] : [""];

	for (const dir of paths) {
		for (const ext of exts) {
			const candidate = path.join(dir, command + ext);
			try {
				if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
					// A real executable wins the first pass, because a no-shell spawn can
					// only run those. .cmd, .bat and .ps1 hits are skipped here and
					// handled in the shim pass below; the extensionless npm entry is an
					// sh script and is never returned at all.
					if (ext === ".exe" || process.platform !== "win32") return candidate;
				}
			} catch {
				/* unreadable entry, keep scanning */
			}
		}
	}

	// Second pass for Windows: accept a batch or PowerShell shim only if no real
	// executable was found. .cmd comes before .ps1 because CreateProcess can run
	// the former with a shell and cannot run the latter at all.
	//
	// The extensionless entry npm writes is an sh script. It is not executable on
	// Windows, so returning it makes the probe report a tool as present and then
	// fail to run it, which is how biome looked missing while being installed.
	if (process.platform === "win32") {
		for (const dir of paths) {
			for (const ext of [".cmd", ".bat"]) {
				const candidate = path.join(dir, command + ext);
				try {
					if (fs.existsSync(candidate) && fs.statSync(candidate).isFile())
						return candidate;
				} catch {
					/* keep scanning */
				}
			}
		}
		// No last resort for .ps1 or extensionless sh scripts. Neither is runnable
		// under CreateProcess, so reporting one as present would make the probe claim a
		// tool exists that nothing can run, and installPlan would then skip installing
		// it. Absent is the honest answer, and it is what triggers the installer.
	}

	return null;
}

// Resolve a binary and, if present, read its version. This is the function handed to
// probe() as the resolver, which is what keeps probe() pure and testable.
export function makeResolver() {
	const cache = new Map();

	return function resolve(binary, versionArgs, spec) {
		const key = binary + "|" + (versionArgs || []).join(" ");
		if (cache.has(key)) return cache.get(key);

		// Some tools have a platform-dependent name. python is python on Windows but
		// usually only python3 on Linux and macOS. The table stays platform-free and
		// the fallback lives here, so one entry covers every OS.
		let found = which(binary);
		let usedBinary = binary;
		if (!found && spec && Array.isArray(spec.alternates)) {
			for (const alt of spec.alternates) {
				const hit = which(alt);
				if (hit) {
					found = hit;
					usedBinary = alt;
					break;
				}
			}
		}
		const out = { found: Boolean(found), path: found, version: null };

		if (found) {
			// Run the RESOLVED path, not the bare name. On Windows the resolved path
			// is often a .cmd shim, and needsShell() keys off the extension, so
			// passing the bare name here would spawn it without a shell and fail
			// with EINVAL even though the tool is installed.
			//
			// The timeout is generous on purpose: on a cold CI runner the first
			// spawn of a Node-based tool can take well over ten seconds, and a
			// timeout here would report a present tool as versionless.
			const r = run(found, versionArgs || [], {
				timeout: 20000,
				shell: spec && spec.shell === true,
			});
			const text = (r.stdout || "") + "\n" + (r.stderr || "");
			const m = /(\d+\.\d+(\.\d+)?)/.exec(text);
			if (m) out.version = m[1];
			// A tool that ran but printed no version is still present.
			if (!out.version && r.status === 0) out.version = "present";
		}

		cache.set(key, out);
		return out;
	};
}

// Write a file only inside the directory given. Returns what it did, so the caller
// can report rather than silently succeed.
export function writeWithin(dir, relativeName, contents) {
	const dest = path.resolve(dir, relativeName);
	const root = path.resolve(dir);
	if (!dest.startsWith(root + path.sep) && dest !== root) {
		return { ok: false, error: "refusing to write outside " + root };
	}
	try {
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.writeFileSync(dest, contents, "utf8");
		return { ok: true, path: dest, bytes: Buffer.byteLength(contents, "utf8") };
	} catch (e) {
		return { ok: false, error: String(e.message || e) };
	}
}
