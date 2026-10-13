// The language table: the single source of truth for what this toolkit checks and
// installs. Kept pure (no imports, no spawning) so the probe logic can be tested
// against it without touching the filesystem.
//
// Adding a language means adding one entry here. Nothing else in the server needs to
// change, because probe(), installPlan() and doctor() all read from this table.

export const LANGUAGE_TABLE = [
	{
		id: "rust",
		label: "Rust",
		server: {
			binary: "rust-analyzer",
			versionArgs: ["--version"],
			component: "rust-analyzer",
		},
		formatter: {
			binary: "rustfmt",
			versionArgs: ["--version"],
			component: "rustfmt",
		},
		linter: {
			binary: "cargo-clippy",
			versionArgs: ["clippy", "--version"],
			component: "clippy",
		},
		toolchain: {
			binary: "cargo",
			installHint: "Install rustup from https://rustup.rs first.",
		},
		install: {
			win32: "rustup component add rust-analyzer rustfmt clippy",
			linux: "rustup component add rust-analyzer rustfmt clippy",
			darwin: "rustup component add rust-analyzer rustfmt clippy",
		},
		// rust-analyzer stays silent on a directory with no Cargo.toml above it, and it
		// shells out to cargo-clippy rather than bundling it.
		trap: "rust-analyzer needs a Cargo.toml at the workspace root or it stays silent. It shells out to cargo-clippy rather than bundling it.",
		projectFile: "Cargo.toml",
	},
	{
		id: "python",
		label: "Python",
		server: { binary: "pyright-langserver", versionArgs: ["--version"] },
		formatter: { binary: "ruff", versionArgs: ["--version"] },
		// python on Windows, usually only python3 on Linux and macOS. The resolver
		// tries the alternates when the primary is absent.
		toolchain: {
			binary: "python",
			alternates: ["python3"],
			versionArgs: ["--version"],
		},
		install: {
			win32: "python -m pip install --user pyright ruff",
			linux: "python3 -m pip install --user pyright ruff",
			darwin: "python3 -m pip install --user pyright ruff",
		},
		// pyright and ruff are separate packages, and pyright returns zero symbols for a
		// document it was never told about.
		trap: "pyright and ruff are separate packages. pyright returns zero symbols for a document it was never opened, so an empty result can mean the client skipped didOpen.",
		projectFile: "pyproject.toml",
	},
	{
		id: "go",
		label: "Go",
		server: { binary: "gopls", versionArgs: ["version"] },
		formatter: { binary: "gofmt", versionArgs: ["--help"] },
		toolchain: { binary: "go", versionArgs: ["version"] },
		install: {
			win32: "go install golang.org/x/tools/gopls@latest",
			linux: "go install golang.org/x/tools/gopls@latest",
			darwin: "go install golang.org/x/tools/gopls@latest",
		},
		// gofmt ships inside the Go toolchain, gopls does not.
		trap: "gofmt ships inside the Go toolchain, gopls does not. gopls needs a go.mod to load the package graph.",
		projectFile: "go.mod",
	},
	{
		id: "cpp",
		label: "C++",
		server: { binary: "clangd", versionArgs: ["--version"] },
		formatter: { binary: "clang-format", versionArgs: ["--version"] },
		toolchain: null,
		install: {
			win32:
				"Install the C++ Clang tools component from the Visual Studio Installer",
			linux: "sudo apt install clangd clang-format",
			darwin: "brew install llvm",
		},
		// compile_commands.json matters for includes, not for symbols. Version skew
		// between a standalone clangd and a toolchain clang-format is common.
		trap: "compile_commands.json is needed for accurate include resolution, not for symbols. A standalone clangd and a toolchain clang-format are often different versions, and they can disagree about valid syntax.",
		projectFile: "compile_commands.json",
		optionalProjectFile: true,
	},
	{
		// Plain C shares the clangd and clang-format binaries with C++, but keeps its
		// own entry so every language id the extension map returns has a home. The
		// .c and .h extensions resolve here; .C, .H and the rest resolve to cpp.
		id: "c",
		label: "C",
		server: { binary: "clangd", versionArgs: ["--version"] },
		formatter: { binary: "clang-format", versionArgs: ["--version"] },
		toolchain: null,
		install: {
			win32:
				"Install the C++ Clang tools component from the Visual Studio Installer",
			linux: "sudo apt install clangd clang-format",
			darwin: "brew install llvm",
		},
		trap: "Shares the clangd and clang-format binaries with C++. compile_commands.json is needed for accurate include resolution, not for symbols.",
		projectFile: "compile_commands.json",
		optionalProjectFile: true,
	},
	{
		id: "typescript",
		label: "TypeScript and JavaScript",
		server: {
			binary: "typescript-language-server",
			versionArgs: ["--version"],
		},
		formatter: { binary: "biome", versionArgs: ["--version"] },
		toolchain: { binary: "node", versionArgs: ["--version"] },
		install: {
			win32:
				"npm install -g typescript typescript-language-server @biomejs/biome",
			linux:
				"npm install -g typescript typescript-language-server @biomejs/biome",
			darwin:
				"npm install -g typescript typescript-language-server @biomejs/biome",
		},
		// TypeScript 7 removed lib/tsserver.js, so a bare `npm install typescript` can
		// install a version the server cannot drive.
		trap: "The project needs a local typescript, and it must be 5.x. TypeScript 7 removed lib/tsserver.js, so a bare npm install typescript installs a version the server cannot drive, and the error blames a missing installation.",
		projectFile: "package.json",
		pinCommand: "npm install --save-dev typescript@5",
		// npm installs this one as .cmd and .ps1 shims and never as a .exe, so a
		// no-shell spawn cannot find it on Windows. That is the whole upstream bug.
		needsWindowsLauncher: true,
	},
	{
		id: "zig",
		label: "Zig",
		server: { binary: "zls", versionArgs: ["--version"] },
		formatter: { binary: "zig", versionArgs: ["version"] },
		toolchain: { binary: "zig", versionArgs: ["version"] },
		install: {
			win32:
				"Install zig 0.16.0, then run: zigup <version> and add zls from the zls releases",
			linux: "Install zig 0.16.0, then build zls from its releases",
			darwin: "Install zig 0.16.0, then build zls from its releases",
		},
		// zls needs a module graph. It is not slow, it has nothing to index.
		trap: "zls needs a build.zig to build a module graph. It is not slow, it has nothing to index until that file exists.",
		projectFile: "build.zig",
	},
	{
		id: "assemblyscript",
		label: "AssemblyScript",
		// There is no separate language server. The TypeScript server covers .ts, and
		// this entry exists only for the eslint-based formatter path.
		server: null,
		formatter: {
			binary: "npx",
			versionArgs: ["--no-install", "eslint", "--version"],
			shell: true,
		},
		toolchain: { binary: "node", versionArgs: ["--version"] },
		install: {
			// eslint is installed because the formatter probe checks for it. Without
			// this, install_missing would report success while the formatter stayed
			// missing.
			win32: "npm install -g typescript-language-server @biomejs/biome eslint",
			linux: "npm install -g typescript-language-server @biomejs/biome eslint",
			darwin: "npm install -g typescript-language-server @biomejs/biome eslint",
		},
		// eslint resolves through npx from the _npx cache and needs a config, or it
		// hard-fails rather than passing silently.
		trap: "eslint resolves through npx from the _npx cache and needs a project-local eslint.config.js. Without that config it hard-fails instead of passing silently.",
		projectFile: "eslint.config.js",
	},
];

// The extensions each language claims, used by the extension lookup helper.
// .C and .H map to cpp rather than c, because that is the convention that
// distinguishes C++ source from C source.
export const EXTENSION_TO_LANGUAGE = {
	".rs": "rust",
	".py": "python",
	".pyi": "python",
	".go": "go",
	".c": "c",
	".h": "c",
	".C": "cpp",
	".H": "cpp",
	".cc": "cpp",
	".cpp": "cpp",
	".cxx": "cpp",
	".hpp": "cpp",
	".hxx": "cpp",
	".hh": "cpp",
	".cppm": "cpp",
	".ixx": "cpp",
	".ts": "typescript",
	".tsx": "typescript",
	".mts": "typescript",
	".cts": "typescript",
	".js": "typescript",
	".jsx": "typescript",
	".mjs": "typescript",
	".cjs": "typescript",
	".zig": "zig",
	".zon": "zig",
};

// Case-sensitive first, lowercase fallback second.
//
// .c and .C are DIFFERENT languages here by convention (.c is C, .C is C++), so a
// blind lowercase-first lookup collapses .C into .c and returns the wrong answer.
// Try the exact extension first, then the lowercased form.
export function languageForFile(filePath) {
	const dot = filePath.lastIndexOf(".");
	if (dot < 0) return "plaintext";
	const raw = filePath.slice(dot);
	if (Object.hasOwn(EXTENSION_TO_LANGUAGE, raw))
		return EXTENSION_TO_LANGUAGE[raw];
	const ext = raw.toLowerCase();
	return EXTENSION_TO_LANGUAGE[ext] || "plaintext";
}
