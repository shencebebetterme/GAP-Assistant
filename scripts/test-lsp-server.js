"use strict";

const assert = require("assert");
const childProcess = require("child_process");
const path = require("path");

const root = path.resolve(__dirname, "..");
const serverPath = path.join(root, "server", "lsp-server.js");
const server = childProcess.spawn(process.execPath, [serverPath], {
  cwd: root,
  stdio: ["pipe", "pipe", "pipe"]
});

const responses = [];
let buffer = Buffer.alloc(0);

server.stdout.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  drain();
});

server.stderr.on("data", (chunk) => {
  process.stderr.write(chunk);
});

function drain() {
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) {
      return;
    }

    const header = buffer.slice(0, headerEnd).toString("utf8");
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    assert(match, "LSP response should contain Content-Length");
    const length = Number.parseInt(match[1], 10);
    const start = headerEnd + 4;
    const end = start + length;
    if (buffer.length < end) {
      return;
    }

    responses.push(JSON.parse(buffer.slice(start, end).toString("utf8")));
    buffer = buffer.slice(end);
  }
}

function send(message) {
  const payload = JSON.stringify({
    jsonrpc: "2.0",
    ...message
  });
  server.stdin.write(`Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`);
}

function waitForResponse(id, timeoutMs = 5000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const found = responses.find((response) => response.id === id);
      if (found) {
        clearInterval(timer);
        resolve(found);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for LSP response ${id}`));
      }
    }, 20);
  });
}

async function main() {
  send({
    id: 1,
    method: "initialize",
    params: {
      processId: process.pid,
      rootUri: null,
      capabilities: {}
    }
  });

  const init = await waitForResponse(1);
  assert(init.result.capabilities.hoverProvider, "server should advertise hoverProvider");

  send({
    method: "textDocument/didOpen",
    params: {
      textDocument: {
        uri: "memory://sample.g",
        languageId: "gap",
        version: 1,
        text: "G := SymmetricGroup(4);\nSize(G);\n"
      }
    }
  });

  send({
    id: 2,
    method: "textDocument/hover",
    params: {
      textDocument: {
        uri: "memory://sample.g"
      },
      position: {
        line: 0,
        character: 1
      }
    }
  });

  const hover = await waitForResponse(2);
  assert(hover.result.contents.value.includes("Static GAP inference"), "hover should include static inference");
  assert(hover.result.contents.value.includes("IsPermGroup"), "hover should include inferred GAP filters");

  send({
    id: 4,
    method: "textDocument/hover",
    params: {
      textDocument: {
        uri: "memory://sample.g"
      },
      position: {
        line: 1,
        character: 1
      }
    }
  });

  const sizeHover = await waitForResponse(4);
  assert(sizeHover.result.contents.value.includes("Input filters"), "hover should include declaration input filters");
  assert(sizeHover.result.contents.value.includes("IsListOrCollection"), "hover should include Size input filter");

  send({ id: 3, method: "shutdown", params: null });
  await waitForResponse(3);
  send({ method: "exit", params: null });
  server.kill();
  console.log("LSP server smoke test passed.");
}

main().catch((error) => {
  server.kill();
  console.error(error);
  process.exit(1);
});
