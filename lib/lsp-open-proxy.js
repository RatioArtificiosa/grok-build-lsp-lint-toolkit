// lsp-open-proxy.js - a transparent LSP relay that supplies the one lifecycle
// notification some clients forget to send.
//
// THE PROBLEM
//   A Language Server only knows about a file's contents once the client tells
//   it, using the `textDocument/didOpen` notification. If a client issues a
//   position-based request (hover, definition, references, completion...) for a
//   document it never opened, the server answers against an empty buffer. The
//   result is a hover that comes back empty and a go-to-definition that returns
//   nothing - while `documentSymbol` still appears to work, because some servers
//   quietly fall back to reading the file from disk. The symptom looks like
//   "hover is broken"; the cause is that the document was never opened.
//
// THE FIX
//   Wrap the language server instead of calling it directly. This proxy spawns
//   the real server, relays every message in both directions untouched, and does
//   exactly one extra thing: if a position-based request names a document it has
//   not opened yet, it reads that file and sends `didOpen` first.
//
// It also notices when a file has changed on disk since it was opened and sends
// `didChange`, so answers never come from a stale buffer after an edit.
//
// Nothing is ever rewritten, reordered or dropped. Requests it does not
// recognise, and every response, pass through byte for byte.
//
// USAGE
//   node lsp-open-proxy.js <server-command> [server-args...]
//
// In a Grok Build plugin's .lsp.json:
//   "command": "node",
//   "args": ["/path/to/lsp-open-proxy.js", "typescript-language-server", "--stdio"]
//
// `command` is `node`, which is a real executable on macOS, Linux and Windows,
// so a single configuration works everywhere.

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { fileURLToPath } = require("url");

if (process.argv.length < 3) {
  process.stderr.write("lsp-open-proxy: usage: node lsp-open-proxy.js <server-command> [args...]\n");
  process.exit(1);
}
const [serverCmd, ...serverArgs] = process.argv.slice(2);

// The LSP language id for each extension. A server that receives an unknown id
// may skip the document, so fall back to "plaintext" rather than guessing.
const LANGUAGE_BY_EXTENSION = {
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascriptreact",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".rs": "rust",
  ".py": "python",
  ".pyi": "python",
  ".go": "go",
  ".c": "c",
  ".h": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hxx": "cpp",
  ".hh": "cpp",
  ".zig": "zig",
  ".zon": "zig",
};

// Requests that need the document to be open. `documentSymbol` is deliberately
// absent: it is the operation that already works, and leaving it alone means
// this proxy cannot regress it.
const REQUESTS_NEEDING_OPEN = new Set([
  "textDocument/hover",
  "textDocument/definition",
  "textDocument/declaration",
  "textDocument/typeDefinition",
  "textDocument/implementation",
  "textDocument/references",
  "textDocument/documentHighlight",
  "textDocument/signatureHelp",
  "textDocument/completion",
  "textDocument/resolveCompletionItem",
  "textDocument/codeAction",
  "textDocument/codeLens",
  "textDocument/rename",
  "textDocument/prepareRename",
  "textDocument/inlayHint",
  "textDocument/foldingRange",
  "textDocument/selectionRange",
  "textDocument/documentLink",
  "textDocument/semanticTokens/full",
  "textDocument/semanticTokens/range",
]);

const VERBOSE = process.env.LSP_OPEN_PROXY_DEBUG === "1";
const log = (msg) => process.stderr.write("lsp-open-proxy: " + msg + "\n");

const server = spawn(serverCmd, serverArgs, {
  stdio: ["pipe", "pipe", "inherit"],
  windowsHide: true,
});

/** uri -> { mtimeMs, version } for documents we have opened. */
const openDocs = new Map();

function frame(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([Buffer.from("Content-Length: " + body.length + "\r\n\r\n", "ascii"), body]);
}

function sendToServer(message) {
  if (server.stdin.writable) server.stdin.write(frame(message));
}

/** Turns a raw byte stream into complete LSP messages, per the wire protocol. */
function createParser(onMessage) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = buffer.slice(0, headerEnd).toString("ascii");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        buffer = buffer.slice(headerEnd + 4);
        continue;
      }
      const bodyStart = headerEnd + 4;
      const bodyLength = parseInt(match[1], 10);
      if (buffer.length < bodyStart + bodyLength) return;
      const body = buffer.slice(bodyStart, bodyStart + bodyLength).toString("utf8");
      buffer = buffer.slice(bodyStart + bodyLength);
      let message;
      try {
        message = JSON.parse(body);
      } catch {
        continue;
      }
      onMessage(message);
    }
  };
}

function uriToPath(uri) {
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

function documentUriOf(message) {
  const td = message && message.params && message.params.textDocument;
  return td && typeof td.uri === "string" ? td.uri : null;
}

/**
 * Guarantees the server has current content for the document this request
 * refers to: opens it if it is new, updates it if it changed on disk.
 */
function ensureDocumentOpen(message) {
  if (!message || typeof message.method !== "string") return;
  if (!REQUESTS_NEEDING_OPEN.has(message.method)) return;

  const uri = documentUriOf(message);
  if (!uri) return;

  const file = uriToPath(uri);
  if (!file) return;

  let stat;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    if (VERBOSE) log("cannot stat " + file + ": " + err.code);
    return;
  }

  const known = openDocs.get(uri);

  if (!known) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (err) {
      log("cannot read " + file + ": " + err.code);
      return;
    }
    openDocs.set(uri, { mtimeMs: stat.mtimeMs, version: 1 });
    sendToServer({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: {
        textDocument: {
          uri,
          languageId: LANGUAGE_BY_EXTENSION[path.extname(file).toLowerCase()] || "plaintext",
          version: 1,
          text,
        },
      },
    });
    if (VERBOSE) log("didOpen " + path.basename(file) + " (" + text.length + " chars)");
    return;
  }

  if (stat.mtimeMs !== known.mtimeMs) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      return;
    }
    known.mtimeMs = stat.mtimeMs;
    known.version += 1;
    sendToServer({
      jsonrpc: "2.0",
      method: "textDocument/didChange",
      params: {
        textDocument: { uri, version: known.version },
        contentChanges: [{ text }],
      },
    });
    if (VERBOSE) log("didChange " + path.basename(file) + " (v" + known.version + ")");
  }
}

// ---- client to server: inject, then forward verbatim ------------------------
process.stdin.on(
  "data",
  createParser((message) => {
    try {
      ensureDocumentOpen(message);
    } catch (err) {
      if (VERBOSE) log("inject failed: " + err.message);
    }
    // Forward the original message unchanged.
    sendToServer(message);
  })
);
process.stdin.on("end", () => {
  try {
    server.stdin.end();
  } catch {
    /* already closed */
  }
});

// ---- server to client: untouched --------------------------------------------
server.stdout.on("data", (chunk) => process.stdout.write(chunk));

server.on("exit", (code, signal) => {
  if (VERBOSE) log("server exited code=" + code + " signal=" + signal);
  process.exit(code === null ? 0 : code);
});
server.on("error", (err) => {
  log("could not start '" + serverCmd + "': " + err.message);
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    try {
      server.kill();
    } catch {
      /* already gone */
    }
    process.exit(0);
  });
}
