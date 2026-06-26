"use strict";

const assert = require("assert");
const path = require("path");
const { GapAnalyzer, formatInferenceMarkdown } = require("../server/analyzer");
const { loadDeclarations, loadDocumentation } = require("../src/docs");

const root = path.resolve(__dirname, "..");
const docs = loadDocumentation(root);
const declarations = loadDeclarations(root);
const analyzer = new GapAnalyzer(docs, declarations);

const sample = `# static inference sample
G := SymmetricGroup(4);
gens := GeneratorsOfGroup(G);
ok := IsGroup(G);
str := "hello";

f := function(n)
    local values;
    values := List([1 .. n], i -> Factorial(i));
    return values;
end;

uses := function(obj)
    local gens;
    gens := GeneratorsOfGroup(obj);
    return Size(gens);
end;

callResult := uses(SymmetricGroup(5));
`;

const analysis = analyzer.analyze(sample, "memory://sample.g");
const globalScope = analysis.scopes[0];
assert(analysis.ast && analysis.ast.type === "program", "analysis should expose the parsed GAP program");
assert(analysis.ast.statements.some((statement) => statement.type === "functionAssignment"), "analysis AST should include function assignments");

const G = globalScope.symbols.get("G");
assert(G, "G should be a global symbol");
assert(G.type.filters.includes("IsGroup"), "G should satisfy IsGroup");
assert(G.type.filters.includes("IsPermGroup"), "G should satisfy IsPermGroup");

const gens = globalScope.symbols.get("gens");
assert(gens, "gens should be a global symbol");
assert(gens.type.filters.includes("IsList"), "gens should satisfy IsList");
assert(gens.type.element.filters.includes("IsMultiplicativeElementWithInverse"), "gens elements should be group-like elements");

const ok = globalScope.symbols.get("ok");
assert(ok, "ok should be a global symbol");
assert(ok.type.filters.includes("IsBool"), "IsGroup should infer boolean");

const str = globalScope.symbols.get("str");
assert(str, "str should be a global symbol");
assert(str.type.filters.includes("IsString"), "string literals should infer IsString");
assert(str.type.filters.includes("IsList"), "GAP strings should also satisfy IsList");

const f = globalScope.symbols.get("f");
assert(f, "f should be a global function symbol");
assert(f.type.filters.includes("IsFunction"), "f should satisfy IsFunction");
assert(f.returnType.filters.includes("IsList"), "f should return a list");

const uses = globalScope.symbols.get("uses");
assert(uses, "uses should be a global function symbol");
assert(uses.parameters[0].type.filters.includes("IsMagmaWithInverses"), "uses parameter should infer filters from GeneratorsOfGroup");
assert(uses.parameters[0].type.filters.includes("IsPermGroup"), "uses parameter should merge filters from call-site arguments");
assert(uses.returnType.filters.includes("IsInt"), "uses should infer Size return as integer-like");
assert(uses.type.parameterTypes[0].filters.includes("IsMagmaWithInverses"), "uses function type should expose parameter filters");

const callResult = globalScope.symbols.get("callResult");
assert(callResult && callResult.type.filters.includes("IsInt"), "callResult should use the inferred return type of uses");

const hoverG = analyzer.hoverAt(sample, 1, 1);
assert(hoverG && hoverG.symbol.name === "G", "hover at G should resolve global symbol");

const hoverGens = analyzer.hoverAt(sample, 2, 1);
assert(hoverGens && hoverGens.symbol.name === "gens", "hover at gens should resolve global symbol");

const hoverFunction = analyzer.hoverAt(sample, 6, 1);
assert(hoverFunction && hoverFunction.symbol.name === "f", "hover at f should resolve user function symbol");

const hoverLocal = analyzer.hoverAt(sample, 8, 6);
assert(hoverLocal && hoverLocal.symbol.name === "values", "hover at values should resolve local symbol");

const hoverBuiltin = analyzer.hoverAt("GeneratorsOfGroup(G);", 0, 3);
assert(hoverBuiltin && hoverBuiltin.symbol.returnType.filters.includes("IsList"), "documented GeneratorsOfGroup should return list");
assert(
  hoverBuiltin.symbol.type.parameterTypes[0].filters.includes("IsMagmaWithInverses"),
  "GeneratorsOfGroup should resolve synonym declaration input filters"
);
const builtinMarkdown = formatInferenceMarkdown(hoverBuiltin);
assert(builtinMarkdown.includes("- `G`: `IsMagmaWithInverses`"), "input filters should use signature parameter names");
assert(builtinMarkdown.includes("### GAP inference"), "static hover should use the terse title");
assert(!builtinMarkdown.includes("```gap"), "static hover should not use a bulky code block");
assert(!builtinMarkdown.includes("Source:"), "static hover should not include internal source lines");
assert(!builtinMarkdown.includes("Documentation return hint"), "static hover should not include documentation return hints");
assert(!builtinMarkdown.includes("Confidence:"), "static hover should not include confidence lines");

const hoverString = analyzer.hoverAt('str := "hello";', 0, 1);
const stringMarkdown = formatInferenceMarkdown(hoverString);
assert(hoverString.symbol.type.filters.includes("IsString"), "hover at a string assignment should infer IsString");
assert(stringMarkdown.includes("`str`"), "string hover should include symbol name");
assert(stringMarkdown.includes("`string`"), "string hover should include terse type label");

const hoverSize = analyzer.hoverAt("Size(G);", 0, 1);
assert(hoverSize.symbol.type.parameterTypes[0].filters.includes("IsListOrCollection"), "Size should expose declaration input filters");

const operatorSample = [
  "n := 5;",
  "m := n + 10;",
  "a := \"hello\";",
  "b := a + 2;",
  ""
].join("\n");
const operatorAnalysis = analyzer.analyze(operatorSample, "memory://operators.g");
const operatorScope = operatorAnalysis.scopes[0];
const m = operatorScope.symbols.get("m");
assert(m && m.type.filters.includes("IsInt"), "integer addition should infer an integer result");
const b = operatorScope.symbols.get("b");
assert(b && b.type.label === "unknown result of +", "invalid string arithmetic should not infer a numeric result");
assert.strictEqual(operatorAnalysis.diagnostics.length, 1, "invalid string arithmetic should produce one diagnostic");
assert(operatorAnalysis.diagnostics[0].message.includes("Operator + may fail"), "diagnostic should explain the operator risk");
assert.strictEqual(operatorAnalysis.diagnostics[0].range.start.line, 3, "diagnostic should point at the invalid operator line");

const flowSample = [
  "flow := function(obj)",
  "    if IsString(obj) then",
  "        bad := obj + 1;",
  "        return obj;",
  "    fi;",
  "    return [];",
  "end;",
  ""
].join("\n");
const flowAnalysis = analyzer.analyze(flowSample, "memory://flow.g");
const flow = flowAnalysis.scopes[0].symbols.get("flow");
assert(flow, "flow should be a global function symbol");
assert(flow.returnType.filters.includes("IsString"), "branch predicate should refine return filters");
assert.strictEqual(flowAnalysis.diagnostics.length, 1, "branch-refined string arithmetic should produce a diagnostic");
assert(flowAnalysis.diagnostics[0].message.includes("left operand is string"), "diagnostic should use the branch-refined type");
const branchHover = flowAnalysis.hoverAt(2, 17);
assert(branchHover && branchHover.symbol.name === "obj", "hover inside a branch should resolve the parameter");
assert(branchHover.symbol.type.filters.includes("IsString"), "branch hover should include the predicate filter");

const callDiagnosticSample = [
  "n := 5;",
  "GeneratorsOfGroup(n);",
  "",
  "checker := function(obj)",
  "    if IsGroup(obj) then",
  "        return GeneratorsOfGroup(obj);",
  "    fi;",
  "    if IsString(obj) then",
  "        return GeneratorsOfGroup(obj);",
  "    fi;",
  "    return [];",
  "end;",
  ""
].join("\n");
const callDiagnosticAnalysis = analyzer.analyze(callDiagnosticSample, "memory://calls.g");
const callDiagnostics = callDiagnosticAnalysis.diagnostics.filter((diagnostic) => diagnostic.code === "call-argument-filter");
assert.strictEqual(callDiagnostics.length, 2, "clearly incompatible declaration-filter calls should be diagnosed");
assert(callDiagnostics[0].message.includes("GeneratorsOfGroup argument 1 may fail"), "call diagnostic should identify the callable");
assert(callDiagnostics[0].message.includes("expected `IsMagmaWithInverses`"), "call diagnostic should include expected GAP filters");
assert(callDiagnostics[0].message.includes("got integer"), "direct call diagnostic should use the inferred argument type");
assert.strictEqual(callDiagnostics[0].range.start.line, 1, "direct call diagnostic should point at the bad call line");
assert(callDiagnostics[1].message.includes("got string"), "branch call diagnostic should use the branch-refined type");
assert.strictEqual(callDiagnostics[1].range.start.line, 8, "branch call diagnostic should point at the guarded bad call line");

const userFunctionCallSample = [
  "uses := function(obj)",
  "    local gens;",
  "    gens := GeneratorsOfGroup(obj);",
  "    return gens;",
  "end;",
  "",
  "uses(5);",
  "G := SymmetricGroup(3);",
  "uses(G);",
  "",
  "guarded := function(obj)",
  "    if IsGroup(obj) then",
  "        return uses(obj);",
  "    fi;",
  "    if IsString(obj) then",
  "        return uses(obj);",
  "    fi;",
  "    return [];",
  "end;",
  ""
].join("\n");
const userFunctionCallAnalysis = analyzer.analyze(userFunctionCallSample, "memory://user-calls.g");
const userCallDiagnostics = userFunctionCallAnalysis.diagnostics.filter((diagnostic) => diagnostic.code === "user-call-argument-filter");
assert.strictEqual(userCallDiagnostics.length, 2, "inferred user-function parameter calls should be diagnosed when incompatible");
assert(userCallDiagnostics[0].message.includes("uses argument 1 may fail"), "user call diagnostic should identify the function");
assert(userCallDiagnostics[0].message.includes("expects `IsMagmaWithInverses`"), "user call diagnostic should include inferred parameter filters");
assert(userCallDiagnostics[0].message.includes("got integer"), "direct user call diagnostic should use the inferred argument type");
assert.strictEqual(userCallDiagnostics[0].range.start.line, 6, "direct user call diagnostic should point at the call argument");
assert(userCallDiagnostics[1].message.includes("got string"), "branch user call diagnostic should use branch-refined filters");
assert.strictEqual(userCallDiagnostics[1].range.start.line, 15, "branch user call diagnostic should point at the guarded call argument");
const usesAfterBadCall = userFunctionCallAnalysis.scopes[0].symbols.get("uses");
assert(!usesAfterBadCall.parameters[0].type.filters.includes("IsInt"), "bad call-site evidence should not pollute inferred parameter filters");

const listMapperSample = [
  "values := List([1 .. 4], i -> Factorial(i));",
  "badValues := List([1 .. 4], i -> i + \"x\");",
  ""
].join("\n");
const listMapperAnalysis = analyzer.analyze(listMapperSample, "memory://list-mapper.g");
const values = listMapperAnalysis.scopes[0].symbols.get("values");
assert(values && values.type.filters.includes("IsList"), "List mapper result should infer a list");
assert(values.type.element && values.type.element.filters.includes("IsPosInt"), "List mapper should infer element type from arrow body");
const mapperHover = listMapperAnalysis.hoverAt(0, 25);
assert(mapperHover && mapperHover.symbol.name === "i", "hover inside List mapper should resolve the arrow parameter");
assert(mapperHover.symbol.type.filters.includes("IsInt"), "List mapper parameter should use the input collection element type");
const listDiagnostics = listMapperAnalysis.diagnostics.filter((diagnostic) => diagnostic.code === "operator-type");
assert.strictEqual(listDiagnostics.length, 1, "invalid arithmetic inside a List mapper should be diagnosed");
assert(listDiagnostics[0].message.includes("left operand is integer"), "List mapper diagnostic should use the arrow parameter type");
assert.strictEqual(listDiagnostics[0].range.start.line, 1, "List mapper diagnostic should point at the mapper body line");

console.log("Analyzer tests passed.");
