"use strict";

const assert = require("assert");
const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.resolve(__dirname, "..");
const adapterPath = path.join(root, "debug", "gapDebugAdapter.js");
const { GapDebugAdapter, normalizeSourcePath, parseHitLine, parseVariableLine, rewriteInstrumentedLocations, runtimeVariableValue, unescapeField } = require("../debug/gapDebugAdapter");

function unitSource(sourcePath, sourceName) {
  const adapter = new GapDebugAdapter(process.stdin, { write() {} });
  adapter.sourceNameByPath.set(sourcePath, sourceName);
  return adapter.sourceFromPath(sourcePath);
}

if (!hasWslGap()) {
  console.log("Debug adapter smoke test skipped because wsl gap is unavailable.");
  process.exit(0);
}

assert.strictEqual(
  normalizeSourcePath("vscode-notebook-cell:/home/user/demo.ipynb#cell-1"),
  "vscode-notebook-cell:/home/user/demo.ipynb#cell-1",
  "notebook cell source URI strings should not be normalized as filesystem paths"
);
assert.deepStrictEqual(
  unitSource("vscode-notebook-cell:/home/user/demo.ipynb#cell-1", "demo.ipynb cell 1"),
  {
    name: "demo.ipynb cell 1",
    path: "vscode-notebook-cell:/home/user/demo.ipynb#cell-1"
  },
  "adapter source objects should preserve notebook cell URIs and display names"
);
assert.strictEqual(
  unescapeField("C:\\\\GAP\\\\examples\\\\test.g"),
  "C:\\GAP\\examples\\test.g",
  "escaped Windows paths ending in test.g should not be parsed as tab escapes"
);
assert.strictEqual(
  parseHitLine("__GAPDEBUG_HIT__\t4\tC:\\\\GAP\\\\examples\\\\test.g\t4\t1\t<main>\t0").sourcePath,
  "C:\\GAP\\examples\\test.g",
  "hit source path should preserve the full Windows file name"
);
assert.strictEqual(
  parseVariableLine("__GAPDEBUG_VAR__\ttext\ttrue\tline\\nnext").value,
  "line\nnext",
  "escaped runtime values should still decode control escapes"
);
assert.strictEqual(
  runtimeVariableValue({
    bound: true,
    value: 'function ( obj ) __GAPDEBUG_Probe( 1, "file", 1, 1, "f", 1, [  ], [  ] ); return obj; end'
  }),
  "function (obj) ... end",
  "instrumented GAP functions should be compacted before display"
);
const locationMap = [];
const sampleSourcePath = path.join(root, "examples", "sample.g");
locationMap[151] = {
  sourcePath: sampleSourcePath,
  line: 71
};
assert.strictEqual(
  rewriteInstrumentedLocations(
    "called from read-eval loop at /tmp/gap-debug-abc/sample.g.debug.g:151",
    ["/tmp/gap-debug-abc/sample.g.debug.g"],
    locationMap
  ),
  `called from read-eval loop at ${sampleSourcePath}:71`,
  "debug console output should rewrite generated GAP file locations to original source locations"
);
const unitAdapterOutput = [];
const unitAdapter = new GapDebugAdapter(process.stdin, {
  write(chunk) {
    unitAdapterOutput.push(String(chunk));
  }
});
unitAdapter.currentProbe = {
  sourcePath: sampleSourcePath,
  line: 71
};
unitAdapter.observeRuntimeOutputForError("Error, <expr> must be 'true' or 'false'\ncalled from sample.g:71\ntype 'quit;' to quit to outer loop");
assert.strictEqual(unitAdapter.paused, true, "adapter should return to a paused state after a GAP runtime error");
assert(unitAdapterOutput.join("").includes("\"reason\":\"exception\""), "adapter should send a stopped exception event after a GAP runtime error");
assert(unitAdapterOutput.join("").includes("gapRuntimeError"), "adapter should send a custom GAP runtime error event for editor decoration");
assert(unitAdapterOutput.join("").includes("<expr> must be"), "adapter stopped event should include the GAP error message");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gap-debug-adapter-test-"));
const program = path.join(tempDir, "sample.g");
fs.writeFileSync(program, [
  "x := 1;",
  "G := SymmetricGroup(4);",
  "p := (1,2,3);",
  "m := [[1, 2], [3, 4]];",
  "r := rec(a := 1, b := \"x\");",
  "F := GF(5);",
  "V := GF(5)^2;",
  "f := function(n)",
  "  local y;",
  "  y := n + x;",
  "  return y;",
  "end;",
  "z := f(2);",
  "w := f(3);",
  "Print(\"NO_NEWLINE\");",
  "Print(\"DONE\\n\");",
  "bad := ForAll([1 .. 2], i -> i + 1);",
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

function scopeReference(scopesResponse, name) {
  const scope = scopesResponse.body.scopes.find((candidate) => candidate.name === name);
  assert(scope, `scope ${name} should be present`);
  return scope.variablesReference;
}

async function main() {
  const initializeSeq = send("initialize", {
    adapterID: "gap",
    supportsVariableType: true
  });
  const initializeResponse = await waitForResponse("initialize", initializeSeq);
  assert.strictEqual(initializeResponse.success, true, "initialize should succeed");
  assert.strictEqual(initializeResponse.body.supportsEvaluateForHovers, true, "adapter should advertise hover evaluation");
  assert.strictEqual(initializeResponse.body.supportsExceptionInfoRequest, true, "adapter should advertise exception info support");
  await waitForEvent("initialized");

  const launchSeq = send("launch", {
    program,
    breakpoints: [
      {
        line: 13
      }
    ],
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
  assert.strictEqual(stack.body.stackFrames[0].line, 13, "stack frame should point at the breakpoint line");
  assert.strictEqual(path.normalize(stack.body.stackFrames[0].source.path), path.normalize(program), "stack frame should use the original source path");

  const scopesSeq = send("scopes", {
    frameId: 1
  });
  const scopes = await waitForResponse("scopes", scopesSeq);
  assert.deepStrictEqual(
    scopes.body.scopes.map((scope) => scope.name),
    ["Locals", "Globals"],
    "adapter should expose separate local and global scopes"
  );
  const localsReference = scopeReference(scopes, "Locals");
  const globalsReference = scopeReference(scopes, "Globals");

  const semanticVariablesSeq = send("gapSemanticVariables", {
    frameId: 1
  });
  const semanticVariables = await waitForResponse("gapSemanticVariables", semanticVariablesSeq);
  assert.strictEqual(semanticVariables.success, true, "semantic variable list request should succeed while GAP is paused");
  assert(
    semanticVariables.body.variables.some((variable) => variable.name === "G" && variable.scope === "global"),
    "semantic variable list should include captured global object names without building every object card"
  );

  const semanticSeq = send("gapSemanticObjects", {
    frameId: 1
  });
  const semantic = await waitForResponse("gapSemanticObjects", semanticSeq);
  assert.strictEqual(semantic.success, true, "semantic object request should succeed while GAP is paused");
  const semanticObjects = semantic.body.objects;
  const semanticGroup = semanticObjects.find((object) => object.name === "G");
  assert(semanticGroup, "semantic objects should include captured permutation groups");
  assert.strictEqual(semanticGroup.label, "Group", "semantic group card should classify GAP groups");
  assert.strictEqual(semanticGroup.knownType, "permutation group", "semantic group card should report the known group representation");
  assert(semanticGroup.facts.some((fact) => fact.label === "Order" && fact.value === "24"), "semantic group card should compute group order");
  assert(semanticGroup.facts.some((fact) => fact.label === "Generators" && fact.value === "2"), "semantic group card should compute generator count");
  assert(semanticGroup.actions.some((action) => action.action === "character-table"), "semantic group card should expose character table action");
  assert(semanticObjects.some((object) => object.name === "p" && object.label === "Permutation"), "semantic objects should include permutations");
  assert(semanticObjects.some((object) => object.name === "m" && object.label === "Matrix"), "semantic objects should include matrices");
  assert(semanticObjects.some((object) => object.name === "r" && object.label === "Record"), "semantic objects should include records");
  assert(semanticObjects.some((object) => object.name === "F" && object.label === "Field"), "semantic objects should include fields");
  assert(semanticObjects.some((object) => object.name === "V" && object.label === "Vector space"), "semantic objects should include vector spaces");

  const selectedSemanticSeq = send("gapSemanticObjects", {
    objectId: "G",
    frameId: 1
  });
  const selectedSemantic = await waitForResponse("gapSemanticObjects", selectedSemanticSeq);
  assert.deepStrictEqual(
    selectedSemantic.body.objects.map((object) => object.name),
    ["G"],
    "semantic object requests should support inspecting one selected variable"
  );

  const semanticActionSeq = send("gapSemanticAction", {
    objectId: "G",
    action: "generators",
    frameId: 1
  });
  const semanticAction = await waitForResponse("gapSemanticAction", semanticActionSeq);
  assert.strictEqual(semanticAction.success, true, "semantic object actions should run while GAP remains paused");
  assert(semanticAction.body.result.includes("(1,2"), "semantic generator action should return GAP generator text");

  const variablesSeq = send("variables", {
    variablesReference: globalsReference
  });
  const variables = await waitForResponse("variables", variablesSeq);
  const x = variables.body.variables.find((variable) => variable.name === "x");
  assert(x, "captured globals should include x");
  assert.strictEqual(x.value, "1", "x should have its runtime value before the function call executes");
  const variableG = variables.body.variables.find((variable) => variable.name === "G");
  assert(variableG, "captured globals should include G");
  assert.strictEqual(variableG.__gapSemanticObjectId, "G", "debug variables should carry semantic object ids");
  assert.strictEqual(
    variableG.__vscodeVariableMenuContext,
    "gapSemanticObject",
    "debug variables should opt into the GAP Objects Variables context menu"
  );
  const f = variables.body.variables.find((variable) => variable.name === "f");
  assert(f, "captured globals should include f");
  assert.strictEqual(f.value, "function (n) ... end", "function variables should not expose inserted debug probe code");
  const initialLocalsSeq = send("variables", {
    variablesReference: localsReference
  });
  const initialLocals = await waitForResponse("variables", initialLocalsSeq);
  assert(!initialLocals.body.variables.some((variable) => variable.name === "x"), "top-level globals should not appear in locals");

  const evaluateSeq = send("evaluate", {
    expression: "x",
    context: "hover",
    frameId: 1
  });
  const evaluate = await waitForResponse("evaluate", evaluateSeq);
  assert.strictEqual(evaluate.body.result, "1", "hover evaluation should return captured variable values");

  const functionHoverSeq = send("evaluate", {
    expression: "f",
    context: "hover",
    frameId: 1
  });
  const functionHover = await waitForResponse("evaluate", functionHoverSeq);
  assert.strictEqual(functionHover.success, false, "hover evaluation should not override static hovers for GAP functions");
  assert(!JSON.stringify(functionHover).includes("__GAPDEBUG_Probe"), "function hover response should not include inserted probe code");

  const systemFunctionHoverSeq = send("evaluate", {
    expression: "SymmetricGroup",
    context: "hover",
    frameId: 1
  });
  const systemFunctionHover = await waitForResponse("evaluate", systemFunctionHoverSeq);
  assert.strictEqual(systemFunctionHover.success, false, "hover evaluation should not show fallback text for uncaptured GAP symbols");
  assert(!JSON.stringify(systemFunctionHover).includes("Only simple captured"), "hover evaluation should not return the fallback text as a hover value");

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
  assert.strictEqual(steppedStack.body.stackFrames[0].line, 14, "next should step over the function call");

  const steppedVariablesSeq = send("variables", {
    variablesReference: globalsReference
  });
  const steppedVariables = await waitForResponse("variables", steppedVariablesSeq);
  const z = steppedVariables.body.variables.find((variable) => variable.name === "z");
  assert(z, "captured variables after stepping over should include z");
  assert.strictEqual(z.value, "3", "z should have its runtime value after stepping over f(2)");

  const stepInEventStart = messages.length;
  const stepInSeq = send("stepIn", {
    threadId: 1
  });
  await waitForResponse("stepIn", stepInSeq);
  const steppedIn = await waitForEvent("stopped", stepInEventStart);
  assert.strictEqual(steppedIn.body.reason, "step", "adapter should stop after a stepIn request");

  const stepInStackSeq = send("stackTrace", {
    threadId: 1
  });
  const stepInStack = await waitForResponse("stackTrace", stepInStackSeq);
  assert.strictEqual(stepInStack.body.stackFrames[0].line, 9, "stepIn should enter the called function body");
  assert.strictEqual(stepInStack.body.stackFrames[0].name, "f", "stepIn frame should use the GAP function name");

  const stepInVariablesSeq = send("variables", {
    variablesReference: localsReference
  });
  const stepInVariables = await waitForResponse("variables", stepInVariablesSeq);
  const n = stepInVariables.body.variables.find((variable) => variable.name === "n");
  assert(n, "captured variables after stepIn should include the function parameter");
  assert.strictEqual(n.value, "3", "stepIn should capture the runtime function argument");
  assert(!stepInVariables.body.variables.some((variable) => variable.name === "x"), "globals should not appear in function locals");
  const stepInGlobalsSeq = send("variables", {
    variablesReference: globalsReference
  });
  const stepInGlobals = await waitForResponse("variables", stepInGlobalsSeq);
  assert(stepInGlobals.body.variables.some((variable) => variable.name === "x"), "function frames should expose inherited globals separately");

  const stepOutEventStart = messages.length;
  const stepOutSeq = send("stepOut", {
    threadId: 1
  });
  await waitForResponse("stepOut", stepOutSeq);
  const steppedOut = await waitForEvent("stopped", stepOutEventStart);
  assert.strictEqual(steppedOut.body.reason, "step", "adapter should stop after a stepOut request");

  const stepOutStackSeq = send("stackTrace", {
    threadId: 1
  });
  const stepOutStack = await waitForResponse("stackTrace", stepOutStackSeq);
  assert.strictEqual(stepOutStack.body.stackFrames[0].line, 15, "stepOut should return to the caller's next statement");

  const stepOutVariablesSeq = send("variables", {
    variablesReference: globalsReference
  });
  const stepOutVariables = await waitForResponse("variables", stepOutVariablesSeq);
  const w = stepOutVariables.body.variables.find((variable) => variable.name === "w");
  assert(w, "captured variables after stepOut should include w");
  assert.strictEqual(w.value, "4", "stepOut should capture the completed caller assignment");

  const errorEventStart = messages.length;
  const continueSeq = send("continue", {
    threadId: 1
  });
  await waitForResponse("continue", continueSeq);
  const errorStopped = await waitForEvent("stopped", errorEventStart);
  assert.strictEqual(errorStopped.body.reason, "exception", "adapter should pause again when GAP reports a runtime error");
  assert(errorStopped.body.text.includes("Error,"), "runtime error stopped popup should include the GAP error message");

  const errorStackSeq = send("stackTrace", {
    threadId: 1
  });
  const errorStack = await waitForResponse("stackTrace", errorStackSeq);
  assert.strictEqual(errorStack.body.stackFrames[0].line, 17, "runtime error stack should point at the original failing GAP line");
  assert.strictEqual(path.normalize(errorStack.body.stackFrames[0].source.path), path.normalize(program), "runtime error stack should use the original source path");

  const errorGlobalsSeq = send("variables", {
    variablesReference: globalsReference
  });
  const errorGlobals = await waitForResponse("variables", errorGlobalsSeq);
  assert(errorGlobals.body.variables.some((variable) => variable.name === "w" && variable.value === "4"), "runtime error pause should preserve the previous captured variable values");
  const gapErrorEvent = await waitFor(
    (message) => message.type === "event" && message.event === "gapRuntimeError",
    "custom GAP runtime error event",
    15000,
    errorEventStart
  );
  assert.strictEqual(gapErrorEvent.body.line, 17, "custom GAP runtime error event should report the original source line");
  assert(gapErrorEvent.body.message.includes("Error,"), "custom GAP runtime error event should include the GAP error message");
  const exceptionInfoSeq = send("exceptionInfo", {
    threadId: 1
  });
  const exceptionInfo = await waitForResponse("exceptionInfo", exceptionInfoSeq);
  assert(exceptionInfo.body.description.includes("Location:"), "exception info should include the original source location");
  assert(exceptionInfo.body.details.stackTrace.includes("ForAll"), "exception info should include GAP stack details");
  await waitFor(
    (message) => message.type === "event" && message.event === "output" && String(message.body.output).includes(`${program}:17`),
    "remapped runtime error source location",
    15000,
    errorEventStart
  );

  const disconnectSeq = send("disconnect", {});
  await waitForResponse("disconnect", disconnectSeq);

  const output = messages
    .filter((message) => message.type === "event" && message.event === "output")
    .map((message) => message.body.output)
    .join("");
  assert(output.includes("NO_NEWLINE"), "debuggee stdout without a trailing newline should be forwarded");
  assert(output.includes("DONE"), "debuggee stdout should be forwarded");
  assert(!output.includes(".debug.g:"), "debuggee output should not expose generated GAP debug source locations");

  adapter.kill();
  safeRemoveTempDir();
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
  safeRemoveTempDir();
  console.error(error);
  process.exit(1);
});

function safeRemoveTempDir() {
  try {
    fs.rmSync(tempDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100
    });
  } catch (_) {
    // WSL can briefly hold the temp script path after GAP exits; the OS temp
    // cleaner can collect it if removal is still denied after retries.
  }
}
