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

console.log("Analyzer tests passed.");
