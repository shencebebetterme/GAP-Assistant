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
assert.deepStrictEqual(topAssignment.variables, [], "first top-level probe should not capture future variables");

const functionAssignment = probes.find((probe) => probe.line === 2);
assert(functionAssignment, "function assignment should get a probe");
assert.deepStrictEqual(functionAssignment.variables, ["x"], "function assignment should capture prior globals");

const localDeclaration = probes.find((probe) => probe.line === 3);
assert(localDeclaration, "local declaration should get a probe");
assert.deepStrictEqual(localDeclaration.variables, ["n", "x", "y"], "local declaration probes should capture the newly declared local");

const functionAssignmentInside = probes.find((probe) => probe.line === 4);
assert(functionAssignmentInside, "function body assignment should get a probe");
assert.deepStrictEqual(functionAssignmentInside.variables, ["n", "x", "y"], "locals should be visible after declaration");

const callProbe = probes.find((probe) => probe.line === 7);
assert(callProbe, "post-function call should get a probe");
assert.deepStrictEqual(callProbe.variables, ["f", "x"], "top-level call should capture earlier assignments");

const instrumented = instrumentGapSource(source, sourcePath).instrumented;
assert(instrumented.includes("__GAPDEBUG_Probe("), "instrumented source should contain probe calls");
assert(instrumented.includes("__GAPDEBUG_Capture(IsBound(x), function() return x; end)"), "instrumented source should capture x");
assert(instrumented.endsWith("QUIT;\n"), "instrumented source should quit after running the file");

console.log("Debug instrumenter tests passed.");
