"use strict";

const assert = require("assert");
const path = require("path");
const { collectProbeMetadata, instrumentGapSource } = require("../debug/instrumenter");

const sourcePath = path.join(process.cwd(), "examples", "debug-sample.g");
const source = [
  "x := 1;",
  "f := function(n)",
  "  local y;",
  "  y := n + x;",
  "  return y;",
  "end;",
  "z := f(2);",
  ""
].join("\n");

const probes = collectProbeMetadata(source, sourcePath);
assert.strictEqual(probes.length, 6, "instrumenter should create probes for executable statements");

const topAssignment = probes.find((probe) => probe.line === 1);
assert(topAssignment, "first assignment should get a probe");
assert.deepStrictEqual(variableNames(topAssignment), [], "first top-level probe should not capture future variables");

const functionAssignment = probes.find((probe) => probe.line === 2);
assert(functionAssignment, "function assignment should get a probe");
assert.deepStrictEqual(variableNames(functionAssignment), ["x"], "function assignment should capture prior globals");
assert.strictEqual(variableScope(functionAssignment, "x"), "global", "top-level assignments should be captured as globals");

const localDeclaration = probes.find((probe) => probe.line === 3);
assert(localDeclaration, "local declaration should get a probe");
assert.deepStrictEqual(variableNames(localDeclaration), ["n", "x", "y"], "local declaration probes should capture the newly declared local");
assert.strictEqual(variableScope(localDeclaration, "n"), "local", "function parameters should be captured as locals");
assert.strictEqual(variableScope(localDeclaration, "x"), "global", "function bodies should preserve inherited globals");
assert.strictEqual(variableScope(localDeclaration, "y"), "local", "local declarations should be captured as locals");

const functionAssignmentInside = probes.find((probe) => probe.line === 4);
assert(functionAssignmentInside, "function body assignment should get a probe");
assert.deepStrictEqual(variableNames(functionAssignmentInside), ["n", "x", "y"], "locals should be visible after declaration");

const callProbe = probes.find((probe) => probe.line === 7);
assert(callProbe, "post-function call should get a probe");
assert.deepStrictEqual(variableNames(callProbe), ["f", "x"], "top-level call should capture earlier assignments");
assert.deepStrictEqual(callProbe.variables.map((variable) => variable.scope), ["global", "global"], "top-level visible variables should be globals");

const instrumentedResult = instrumentGapSource(source, sourcePath);
const instrumented = instrumentedResult.instrumented;
assert(instrumented.includes("__GAPDEBUG_Probe("), "instrumented source should contain probe calls");
assert(instrumented.includes("__GAPDEBUG_Capture(IsBound(x), function() return x; end)"), "instrumented source should capture x");
assert(instrumented.endsWith("QUIT;\n"), "instrumented source should quit after running the file");
const generatedCallLine = instrumented.split(/\n/).findIndex((line) => line.includes("z := f(2);")) + 1;
assert.strictEqual(
  instrumentedResult.lineMap[generatedCallLine].line,
  7,
  "instrumented line map should map generated source lines back to original GAP lines"
);

const withRuntimePrelude = instrumentGapSource("z := x + 1;\n", sourcePath, {
  runtimePrelude: "x := 41;"
});
assert(withRuntimePrelude.instrumented.includes("x := 41;\n"), "runtime preludes should execute before the debugged source");
const generatedPreludeCallLine = withRuntimePrelude.instrumented.split(/\n/).findIndex((line) => line.includes("z := x + 1;")) + 1;
assert.strictEqual(
  withRuntimePrelude.lineMap[generatedPreludeCallLine].line,
  1,
  "runtime preludes should not shift original source line mapping"
);

const librarySource = instrumentGapSource("helper := 1;\n", path.join(process.cwd(), "examples", "helper.g"), {
  includePrelude: false,
  probeIdStart: 40,
  quitOnExit: false
});
assert(!librarySource.instrumented.includes("__GAPDEBUG_MaxValueLength"), "included debug files should not repeat the debug prelude");
assert(!librarySource.instrumented.includes("QUIT;"), "included debug files should not quit the GAP session after Read");
assert.strictEqual(librarySource.probes[0].id, 40, "included debug probes should accept a global id offset");

console.log("Debug instrumenter tests passed.");

function variableNames(probe) {
  return probe.variables.map((variable) => variable.name);
}

function variableScope(probe, name) {
  const variable = probe.variables.find((candidate) => candidate.name === name);
  return variable && variable.scope;
}
