"use strict";

const assert = require("assert");
const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

const root = path.resolve(__dirname, "..");
const serverPath = path.join(root, "server", "lsp-server.js");
const server = childProcess.spawn(process.execPath, [serverPath], {
  cwd: root,
  stdio: ["pipe", "pipe", "pipe"]
});

function hasHoverText(markdown, value) {
  return markdown.includes(value);
}

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

function waitForNotification(method, predicate = () => true, timeoutMs = 5000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const found = responses.find((response) => response.method === method && predicate(response.params || {}));
      if (found) {
        clearInterval(timer);
        resolve(found);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for LSP notification ${method}`));
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
        text: [
          "G := SymmetricGroup(4);",
          "str := \"hello\";",
          "Size(G);",
          "uses := function(obj)",
          "    return Size(obj);",
          "end;",
          "uses(G);",
          "bad := str + 2;",
          ""
        ].join("\n")
      }
    }
  });

  const diagnostics = await waitForNotification("textDocument/publishDiagnostics", (params) => params.uri === "memory://sample.g");
  assert.strictEqual(diagnostics.params.diagnostics.length, 1, "server should publish one operator diagnostic");
  assert(diagnostics.params.diagnostics[0].message.includes("Operator + may fail"), "diagnostic should explain the operator risk");
  assert.strictEqual(diagnostics.params.diagnostics[0].range.start.line, 7, "diagnostic should point at the invalid operator line");

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
  assert(hasHoverText(hover.result.contents.value, "```gap"), "hover should include a syntax-highlightable GAP code block");
  assert(hasHoverText(hover.result.contents.value, "G: symmetric permutation group"), "hover should include inferred GAP symbol and type");
  assert(!hover.result.contents.value.includes("GAP inference"), "hover should omit the verbose inference title");
  assert(!hover.result.contents.value.includes("Source:"), "hover should not include internal source lines");
  assert(!hover.result.contents.value.includes("Confidence:"), "hover should not include confidence lines");

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

  const stringHover = await waitForResponse(4);
  assert(hasHoverText(stringHover.result.contents.value, "str: string"), "hover should infer string literal assignments");
  assert(!stringHover.result.contents.value.includes("IsString"), "hover should not repeat string filters");

  send({
    id: 6,
    method: "textDocument/hover",
    params: {
      textDocument: {
        uri: "memory://sample.g"
      },
      position: {
        line: 2,
        character: 1
      }
    }
  });

  const sizeHover = await waitForResponse(6);
  assert(sizeHover.result.contents.value.includes("```gap\nfunction("), "hover signature should use a syntax-highlightable GAP code block");
  assert(hasHoverText(sizeHover.result.contents.value, "list or collection"), "hover signature should include styled Size input type");
  assert(!sizeHover.result.contents.value.includes("Input filters"), "hover should not repeat declaration input filters");

  send({
    id: 5,
    method: "textDocument/hover",
    params: {
      textDocument: {
        uri: "memory://sample.g"
      },
      position: {
        line: 3,
        character: 1
      }
    }
  });

  const functionHover = await waitForResponse(5);
  assert(functionHover.result.contents.value.includes("```gap\nfunction("), "function hover should include a syntax-highlightable function signature");
  assert(hasHoverText(functionHover.result.contents.value, "obj:"), "function hover should include the parameter name");
  assert(hasHoverText(functionHover.result.contents.value, "list or collection"), "function hover should include body-derived input requirement in the signature");
  assert(!functionHover.result.contents.value.includes("permutation group"), "function hover should not narrow requirements to one call-site type");
  assert(!functionHover.result.contents.value.includes("Source:"), "function hover should not include internal source lines");

  const includeDir = fs.mkdtempSync(path.join(os.tmpdir(), "gap-assist-lsp-includes-"));
  try {
    const yPath = path.join(includeDir, "y.g");
    const xPath = path.join(includeDir, "x.g");
    fs.writeFileSync(yPath, [
      "NeedsGroup := function(obj)",
      "    return GeneratorsOfGroup(obj);",
      "end;",
      ""
    ].join("\n"), "utf8");
    const xText = [
      "Read(\"y.g\");",
      "G := SymmetricGroup(4);",
      "gens := NeedsGroup(G);",
      "bad := NeedsGroup(5);",
      ""
    ].join("\n");
    const xUri = pathToFileURL(xPath).toString();

    send({
      method: "textDocument/didOpen",
      params: {
        textDocument: {
          uri: xUri,
          languageId: "gap",
          version: 1,
          text: xText
        }
      }
    });

    const includeDiagnostics = await waitForNotification("textDocument/publishDiagnostics", (params) => params.uri === xUri);
    const importedCallDiagnostics = includeDiagnostics.params.diagnostics.filter((diagnostic) => diagnostic.code === "user-call-argument-filter");
    assert.strictEqual(importedCallDiagnostics.length, 1, "server diagnostics should see functions imported with Read");
    assert(importedCallDiagnostics[0].message.includes("NeedsGroup argument 1 may fail"), "server diagnostic should name the imported function");

    send({
      id: 7,
      method: "textDocument/hover",
      params: {
        textDocument: {
          uri: xUri
        },
        position: {
          line: 2,
          character: 10
        }
      }
    });

    const includeHover = await waitForResponse(7);
    assert(includeHover.result.contents.value.includes("```gap\nfunction("), "server hover should show imported function signatures");
    assert(hasHoverText(includeHover.result.contents.value, "obj: group"), "server hover should include imported function parameter inference");
  } finally {
    fs.rmSync(includeDir, { recursive: true, force: true });
  }

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
