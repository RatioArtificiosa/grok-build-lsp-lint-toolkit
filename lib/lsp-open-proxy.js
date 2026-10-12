// lsp-open-proxy.js - a transparent LSP relay that supplies the lifecycle
// notifications some clients forget to send.
//
// THE PROBLEM
//   A language server only knows what is in a file once the client tells it,
//   using the `textDocument/didOpen` notification. A client that issues a
//   position-based request (hover, definition, references, completion) for a
//   document it never opened gets an answer computed against an empty buffer:
//   an empty hover, a null definition. `documentSymbol` can appear to work
//   anyway, because some servers quietly re-read the file from disk. The
//   symptom reads as "hover is broken"; the cause is that nobody opened the
//   document.
//
// THE FIX
//   Wrap the server instead of calling it directly. This proxy spawns the real
//   server, relays traffic in both directions, and does one extra thing: before
//   a request that needs a document, it makes sure the document's current
//   contents are on the server. It opens the file if the server has never seen
//   it, pushes a change if the bytes moved on disk, and closes it if it is gone.
//
// WHAT IT WILL NOT DO
//   It never rewrites, reorders or drops a client message. Each frame is
//   forwarded as the exact bytes that arrived, and the parse that decides
//   whether to inject is done on a separate copy. If a frame ever fails to
//   parse, the proxy stops injecting and drains the rest of the stream
//   verbatim, so the worst case is a plain pipe rather than a corrupted one.
//
// USAGE
//   node lsp-open-proxy.js <server-command> [server-args...]
//
// In a Grok Build plugin's .lsp.json:
//   "command": "node",
//   "args": ["/path/to/lsp-open-proxy.js", "typescript-language-server", "--stdio"]
//
// `command` is `node`, a real executable on macOS, Linux and Windows, so one
// configuration works everywhere. Set GROK_LSP_PROXY_DEBUG=1 to trace the
// lifecycle notifications it injects. It is silent otherwise.

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { fileURLToPath } = require("url");

const argv = process.argv.slice(2);
if (argv.length === 0) {
  process.stderr.write("lsp-open-proxy: usage: node lsp-open-proxy.js <server-command> [args...]\n");
  process.exit(2);
}
const [serverCmd, ...serverArgs] = argv;

const DEBUG = process.env.GROK_LSP_PROXY_DEBUG === "1";

// The language id a server expects for each extension. A server that receives
// an id it does not know may skip the document entirely, so an unmapped
// extension falls back to "plaintext" rather than guessing.
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
  ".hh": "cpp",
  ".hpp": "cpp",
  ".hxx": "cpp",
  ".zig": "zig",
  ".zon": "zig",
};

// Requests whose answer depends on the document's contents. Everything else is
// forwarded without touching document state.
//
// documentSymbol is included deliberately. It was excluded at first, on the
// reasoning that it already worked and should be left alone. That reasoning was
// wrong: it works only on servers that fall back to reading from disk. pyright
// does not, and returns zero symbols for a document it was never told about,
// so the exclusion silently broke Python in order to avoid touching operations
// that were fine. Measured: 7 symbols opened, 0 not.
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
  "textDocument/documentSymbol",
]);

const log = (...parts) => {
  if (DEBUG) process.stderr.write("lsp-open-proxy: " + parts.join(" ") + "\n");
};

// stderr is inherited, so a server's own diagnostics still reach the client.
const server = spawn(serverCmd, serverArgs, {
  stdio: ["pipe", "pipe", "inherit"],
  windowsHide: true,
});

server.on("error", (err) => {
  process.stderr.write("lsp-open-proxy: could not start '" + serverCmd + "': " + err.message + "\n");
  process.exit(1);
});

// A write to a server that has already exited raises EPIPE. It is not worth
// crashing the session over; the exit handler will end the proxy.
server.stdin.on("error", (err) => log("server stdin: " + err.code));
server.stdout.on("error", (err) => log("server stdout: " + err.code));

function writeToServer(bytes) {
  if (!server.stdin.writable) return;
  try {
    server.stdin.write(bytes);
  } catch (err) {
    log("write failed: " + err.message);
  }
}

function frame(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([Buffer.from("Content-Length: " + body.length + "\r\n\r\n", "ascii"), body]);
}

function sha1(text) {
  return crypto.createHash("sha1").update(text, "utf8").digest("hex");
}

function uriToPath(uri) {
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

/** uri -> { version, hash }. `hash` is what makes drift detectable. */
const openDocs = new Map();

// Bring the server's view of one document in line with what is on disk.
//
// Drift is re-checked on every request rather than trusting an "already opened"
// set. Keying only on the URI means the server answers from version 1 forever
// after an edit: measured, hover kept reporting a return type of `string` after
// the file changed to `number`. Hashing the text makes that impossible, and on
// the common path where nothing changed it costs one sha1.
function ensureDocumentOpen(message) {
  if (!message || typeof message.method !== "string") return;
  if (!REQUESTS_NEEDING_OPEN.has(message.method)) return;

  const doc = message.params && message.params.textDocument;
  const uri = doc && typeof doc.uri === "string" ? doc.uri : null;
  if (!uri) return;

  const file = uriToPath(uri);
  if (!file) return;

  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    // Gone from disk. Tell the server once, then stop claiming to know it.
    if (openDocs.has(uri)) {
      writeToServer(
        frame({ jsonrpc: "2.0", method: "textDocument/didClose", params: { textDocument: { uri } } })
      );
      openDocs.delete(uri);
      log("didClose " + path.basename(file) + " (gone from disk)");
    } else {
      log("cannot read " + file + ": " + err.code);
    }
    return;
  }

  const hash = sha1(text);
  const known = openDocs.get(uri);

  if (!known) {
    const languageId = LANGUAGE_BY_EXTENSION[path.extname(file).toLowerCase()] || "plaintext";
    writeToServer(
      frame({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: { textDocument: { uri, languageId, version: 1, text } },
      })
    );
    openDocs.set(uri, { version: 1, hash });
    log("didOpen " + path.basename(file) + " (" + text.length + " chars, " + languageId + ")");
    return;
  }

  if (known.hash === hash) return;

  // The bytes moved. Replacing the whole document avoids computing a minimal
  // diff, which the protocol does not require.
  known.version += 1;
  known.hash = hash;
  writeToServer(
    frame({
      jsonrpc: "2.0",
      method: "textDocument/didChange",
      params: { textDocument: { uri, version: known.version }, contentChanges: [{ text }] },
    })
  );
  log("didChange " + path.basename(file) + " -> version " + known.version + " (" + text.length + " chars)");
}

// ---- client -> server -------------------------------------------------------
//
// Frames are forwarded as the bytes that arrived. The message is parsed only to
// decide whether an injection is needed, and the parse happens on a byte range
// that the forwarder has already captured, so a message this proxy does not
// understand still crosses the wire exactly as the client wrote it.
let pending = Buffer.alloc(0);
let relayOnly = false;

function handleChunk(chunk) {
  pending = Buffer.concat([pending, chunk]);

  for (;;) {
    if (relayOnly) {
      // A previous frame defeated the parser. Stop inspecting and let the rest
      // of the stream through as-is; a dumb pipe beats a lossy one.
      if (pending.length) {
        writeToServer(pending);
        pending = Buffer.alloc(0);
      }
      return;
    }

    const headerEnd = pending.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;

    const header = pending.slice(0, headerEnd).toString("ascii");
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) {
      log("unparsable header, switching to relay-only");
      relayOnly = true;
      continue;
    }

    const bodyStart = headerEnd + 4;
    const bodyLength = parseInt(match[1], 10);
    if (pending.length < bodyStart + bodyLength) return;

    const whole = pending.slice(0, bodyStart + bodyLength);
    pending = pending.slice(bodyStart + bodyLength);

    try {
      const message = JSON.parse(whole.slice(bodyStart).toString("utf8"));
      ensureDocumentOpen(message);
    } catch (err) {
      log("inspect failed (" + err.message + "), forwarding unchanged");
    }

    writeToServer(whole);
  }
}

process.stdin.on("data", (chunk) => {
  try {
    handleChunk(chunk);
  } catch (err) {
    // Nothing here is worth dropping the client's bytes over.
    log("handler failed: " + err.message);
    relayOnly = true;
    handleChunk(Buffer.alloc(0));
  }
});

let shuttingDown = false;
process.stdin.on("end", () => {
  if (shuttingDown) return;
  shuttingDown = true;

  // Release the buffers this proxy opened instead of pinning them until the
  // process dies. Closing is deferred briefly so the didClose frames flush
  // before stdin closes under them.
  try {
    for (const uri of openDocs.keys()) {
      writeToServer(
        frame({ jsonrpc: "2.0", method: "textDocument/didClose", params: { textDocument: { uri } } })
      );
    }
    openDocs.clear();
  } catch (err) {
    log("close-all failed: " + err.message);
  }

  setTimeout(() => {
    try {
      server.stdin.end();
    } catch {
      /* already closed */
    }
  }, 50);
});

// ---- server -> client -------------------------------------------------------
//
// Byte-for-byte, with backpressure so a large response cannot balloon memory.
server.stdout.on("data", (chunk) => {
  if (!process.stdout.write(chunk)) {
    server.stdout.pause();
    process.stdout.once("drain", () => server.stdout.resume());
  }
});

server.on("exit", (code, signal) => {
  log("server exited code=" + code + " signal=" + signal);
  // Not process.exit(): that discards anything still queued on stdout, which is
  // how a final response gets truncated. Setting exitCode lets Node drain first
  // and leave on its own.
  process.exitCode = code === null ? 0 : code;
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
