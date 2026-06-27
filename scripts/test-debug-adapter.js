"use strict";

const assert = require("assert");
const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.resolve(__dirname, "..");
const adapterPath = path.join(root, "debug", "gapDebugAdapter.js");

if (!hasWslGap()) {
  console.log("Debug adapter smoke test skipped because wsl gap is unavailable.");
  process.exit(0);
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gap-debug-adapter-test-"));
const program = path.join(tempDir, "sample.g");
fs.writeFileSync(program, [
  "x := 1;",
  "y := x + 2;",
  "Print(\"DONE\\n\");",
  ""
].join("\n"), "utf8");

const adapter = childProcess.spawn(process.execPath, [adapterPath], {
  cwd: root,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true
});

const messages = [];
let buffer = Buffer.alloc(0);
let nextSeq = 1;

adapter.stdout.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  drainMessages();
});

adapter.stderr.on("data", (chunk) => {
  process.stderr.write(chunk);
});

function drainMessages() {
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) {
      return;
    }

    const header = buffer.slice(0, headerEnd).toString("utf8");
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    assert(match, "DAP message should contain Content-Length");
    const length = Number.parseInt(match[1], 10);
    const start = headerEnd + 4;
    const end = start + length;
    if (buffer.length < end) {
      return;
    }

    messages.push(JSON.parse(buffer.slice(start, end).toString("utf8")));
    buffer = buffer.slice(end);
  }
}

function send(command, args) {
  const message = {
    seq: nextSeq,
    type: "request",
    command,
    arguments: args
  };
  nextSeq += 1;
  const payload = JSON.stringify(message);
  adapter.stdin.write(`Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`);
  return message.seq;
}

function waitFor(predicate, label, timeoutMs = 15000, startIndex = 0) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const found = messages.slice(startIndex).find(predicate);
      if (found) {
        clearInterval(timer);
        resolve(found);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for ${label}`));
      }
    }, 20);
  });
}

function waitForResponse(command, requestSeq) {
  return waitFor(
    (message) => message.type === "response" && message.command === command && message.request_seq === requestSeq,
    `${command} response`
  );
}

function waitForEvent(event, startIndex = 0) {
  return waitFor((message) => message.type === "event" && message.event === event, `${event} event`, 15000, startIndex);
}

async function main() {
  const initializeSeq = send("initialize", {
    adapterID: "gap",
    supportsVariableType: true
  });
  const initializeResponse = await waitForResponse("initialize", initializeSeq);
  assert.strictEqual(initializeResponse.success, true, "initialize should succeed");
  assert.strictEqual(initializeResponse.body.supportsEvaluateForHovers, true, "adapter should advertise hover evaluation");
  await waitForEvent("initialized");

  const breakpointsSeq = send("setBreakpoints", {
    source: {
      name: "sample.g",
      path: program
    },
    breakpoints: [
      {
        line: 2
      }
    ]
  });
  const breakpointsResponse = await waitForResponse("setBreakpoints", breakpointsSeq);
  assert.strictEqual(breakpointsResponse.body.breakpoints.length, 1, "one breakpoint should be returned");
  assert.strictEqual(breakpointsResponse.body.breakpoints[0].verified, true, "line breakpoint should be verified");
  assert.strictEqual(breakpointsResponse.body.breakpoints[0].line, 2, "breakpoint should stay on executable line 2");

  const launchSeq = send("launch", {
    program,
    gapCommand: "wsl",
    stopOnEntry: false,
    maxValueLength: 200
  });
  await waitForResponse("launch", launchSeq);

  const configurationSeq = send("configurationDone", {});
  await waitForResponse("configurationDone", configurationSeq);

  const stopped = await waitForEvent("stopped");
  assert.strictEqual(stopped.body.reason, "breakpoint", "adapter should stop at the breakpoint");

  const stackSeq = send("stackTrace", {
    threadId: 1
  });
  const stack = await waitForResponse("stackTrace", stackSeq);
  assert.strictEqual(stack.body.stackFrames.length, 1, "adapter should report the current GAP frame");
  assert.strictEqual(stack.body.stackFrames[0].line, 2, "stack frame should point at the breakpoint line");
  assert.strictEqual(path.normalize(stack.body.stackFrames[0].source.path), path.normalize(program), "stack frame should use the original source path");

  const scopesSeq = send("scopes", {
    frameId: 1
  });
  const scopes = await waitForResponse("scopes", scopesSeq);
  assert.strictEqual(scopes.body.scopes.length, 1, "adapter should expose locals scope");

  const variablesSeq = send("variables", {
    variablesReference: scopes.body.scopes[0].variablesReference
  });
  const variables = await waitForResponse("variables", variablesSeq);
  const x = variables.body.variables.find((variable) => variable.name === "x");
  assert(x, "captured variables should include x");
  assert.strictEqual(x.value, "1", "x should have its runtime value before line 2 executes");

  const evaluateSeq = send("evaluate", {
    expression: "x",
    context: "hover",
    frameId: 1
  });
  const evaluate = await waitForResponse("evaluate", evaluateSeq);
  assert.strictEqual(evaluate.body.result, "1", "hover evaluation should return captured variable values");

  const stepEventStart = messages.length;
  const nextSeq = send("next", {
    threadId: 1
  });
  await waitForResponse("next", nextSeq);
  const stepped = await waitForEvent("stopped", stepEventStart);
  assert.strictEqual(stepped.body.reason, "step", "adapter should stop after a step request");

  const steppedStackSeq = send("stackTrace", {
    threadId: 1
  });
  const steppedStack = await waitForResponse("stackTrace", steppedStackSeq);
  assert.strictEqual(steppedStack.body.stackFrames[0].line, 3, "step should advance to the next executable statement");

  const steppedVariablesSeq = send("variables", {
    variablesReference: scopes.body.scopes[0].variablesReference
  });
  const steppedVariables = await waitForResponse("variables", steppedVariablesSeq);
  const y = steppedVariables.body.variables.find((variable) => variable.name === "y");
  assert(y, "captured variables after stepping should include y");
  assert.strictEqual(y.value, "3", "y should have its runtime value after line 2 executes");

  const continueSeq = send("continue", {
    threadId: 1
  });
  await waitForResponse("continue", continueSeq);
  await waitForEvent("terminated");

  const output = messages
    .filter((message) => message.type === "event" && message.event === "output")
    .map((message) => message.body.output)
    .join("");
  assert(output.includes("DONE"), "debuggee stdout should be forwarded");

  adapter.kill();
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log("Debug adapter smoke test passed.");
}

function hasWslGap() {
  const result = childProcess.spawnSync("wsl", ["gap", "-q", "-b", "-c", "QUIT;"], {
    encoding: "utf8",
    windowsHide: true
  });
  return result.status === 0;
}

main().catch((error) => {
  adapter.kill();
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.error(error);
  process.exit(1);
});
