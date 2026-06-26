"use strict";

const fs = require("fs");
const path = require("path");
const { GapAnalyzer, formatInferenceMarkdown } = require("./analyzer");

const docsPath = path.join(__dirname, "..", "data", "gap-docs.json");
const declarationsPath = path.join(__dirname, "..", "data", "gap-declarations.json");
const docs = JSON.parse(fs.readFileSync(docsPath, "utf8"));
const declarations = JSON.parse(fs.readFileSync(declarationsPath, "utf8"));
const analyzer = new GapAnalyzer(docs, declarations);
const documents = new Map();

let buffer = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  drainMessages();
});

function drainMessages() {
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) {
      return;
    }

    const header = buffer.slice(0, headerEnd).toString("utf8");
    const contentLengthMatch = /Content-Length:\s*(\d+)/i.exec(header);
    if (!contentLengthMatch) {
      throw new Error("Missing Content-Length header");
    }

    const contentLength = Number.parseInt(contentLengthMatch[1], 10);
    const messageStart = headerEnd + 4;
    const messageEnd = messageStart + contentLength;
    if (buffer.length < messageEnd) {
      return;
    }

    const payload = buffer.slice(messageStart, messageEnd).toString("utf8");
    buffer = buffer.slice(messageEnd);
    handleMessage(JSON.parse(payload));
  }
}

function handleMessage(message) {
  if (message.method === "initialize") {
    respond(message.id, {
      capabilities: {
        textDocumentSync: 1,
        hoverProvider: true
      },
      serverInfo: {
        name: "gap-reference-assistant-language-server",
        version: "0.3.4"
      }
    });
    return;
  }

  if (message.method === "initialized" || message.method === "shutdown" || message.method === "exit") {
    if (message.id !== undefined && message.method === "shutdown") {
      respond(message.id, null);
    }
    if (message.method === "exit") {
      process.exit(0);
    }
    return;
  }

  if (message.method === "textDocument/didOpen") {
    const doc = message.params.textDocument;
    documents.set(doc.uri, doc.text || "");
    publishDiagnostics(doc.uri, doc.text || "");
    return;
  }

  if (message.method === "textDocument/didChange") {
    const uri = message.params.textDocument.uri;
    const change = message.params.contentChanges[message.params.contentChanges.length - 1];
    if (change && typeof change.text === "string") {
      documents.set(uri, change.text);
      publishDiagnostics(uri, change.text);
    }
    return;
  }

  if (message.method === "textDocument/hover") {
    const uri = message.params.textDocument.uri;
    const text = documents.get(uri) || "";
    const position = message.params.position;
    const hover = analyzer.hoverAt(text, position.line, position.character, uri);
    if (!hover) {
      respond(message.id, null);
      return;
    }

    respond(message.id, {
      contents: {
        kind: "markdown",
        value: formatInferenceMarkdown(hover)
      }
    });
    return;
  }

  if (message.id !== undefined) {
    respondError(message.id, -32601, `Unsupported method: ${message.method}`);
  }
}

function respond(id, result) {
  writeMessage({
    jsonrpc: "2.0",
    id,
    result
  });
}

function respondError(id, code, message) {
  writeMessage({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message
    }
  });
}

function publishDiagnostics(uri, text) {
  const analysis = analyzer.analyze(text, uri);
  writeMessage({
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: {
      uri,
      diagnostics: analysis.diagnostics
    }
  });
}

function writeMessage(message) {
  const payload = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`);
}
