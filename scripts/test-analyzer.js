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
assert(!uses.parameters[0].type.filters.includes("IsPermGroup"), "uses parameter requirements should not be narrowed by call-site arguments");
assert(uses.parameters[0].type.observedFilters.includes("IsPermGroup"), "uses parameter should keep call-site filters as observed evidence");
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

const hoverUsesFunction = analyzer.hoverAt(sample, 12, 1);
const hoverUsesMarkdown = formatInferenceMarkdown(hoverUsesFunction);
assert(hoverUsesMarkdown.includes("<strong>group</strong>"), "function hover should show broad group requirement from GeneratorsOfGroup");
assert(!hoverUsesMarkdown.includes("<strong>permutation group</strong>"), "function hover should not show one permutation-group call site as a requirement");

const hoverLocal = analyzer.hoverAt(sample, 8, 6);
assert(hoverLocal && hoverLocal.symbol.name === "values", "hover at values should resolve local symbol");

const hoverBuiltin = analyzer.hoverAt("GeneratorsOfGroup(G);", 0, 3);
assert(hoverBuiltin && hoverBuiltin.symbol.returnType.filters.includes("IsList"), "documented GeneratorsOfGroup should return list");
assert(
  hoverBuiltin.symbol.type.parameterTypes[0].filters.includes("IsMagmaWithInverses"),
  "GeneratorsOfGroup should resolve synonym declaration input filters"
);
const builtinMarkdown = formatInferenceMarkdown(hoverBuiltin);
assert(builtinMarkdown.includes("#### GAP inference"), "static hover should use the inference title");
assert(builtinMarkdown.includes("<div style="), "static hover should include a compact styled signature block");
assert(builtinMarkdown.includes("# system function"), "documented hover should show the callable scope");
assert(builtinMarkdown.includes("<code>GeneratorsOfGroup</code>"), "documented hover should show the callable name");
assert(builtinMarkdown.includes("<strong>group</strong>"), "documented hover should style group-like input types");
assert(builtinMarkdown.includes("<strong>list</strong>"), "documented hover should style return types");
assert(!builtinMarkdown.includes("**Type**"), "static hover should not repeat the signature type");
assert(!builtinMarkdown.includes("**Filters**"), "static hover should not repeat top-level filters");
assert(!builtinMarkdown.includes("Input filters"), "static hover should not repeat signature input filters");
assert(!builtinMarkdown.includes("Source:"), "static hover should not include internal source lines");
assert(!builtinMarkdown.includes("Documentation return hint"), "static hover should not include documentation return hints");
assert(!builtinMarkdown.includes("Confidence:"), "static hover should not include confidence lines");

const hoverString = analyzer.hoverAt('str := "hello";', 0, 1);
const stringMarkdown = formatInferenceMarkdown(hoverString);
assert(hoverString.symbol.type.filters.includes("IsString"), "hover at a string assignment should infer IsString");
assert(stringMarkdown.includes("# global variable"), "string hover should include the variable scope");
assert(stringMarkdown.includes("<code>str</code>"), "string hover should include a readable value signature");
assert(stringMarkdown.includes("<strong>string</strong>"), "string hover should style the inferred type");

const containerHoverSample = [
  "values := List([1 .. 5], i -> Factorial(i));",
  "info := rec(count := Length(values), name := \"gap\", first := values[1]);",
  ""
].join("\n");
const containerHoverAnalysis = analyzer.analyze(containerHoverSample, "memory://container-hover.g");
const valuesHover = containerHoverAnalysis.hoverAt(0, 1);
const valuesMarkdown = formatInferenceMarkdown(valuesHover);
assert(valuesMarkdown.includes("<code>values</code>"), "list hover should show the variable name in its signature");
assert(valuesMarkdown.includes("<strong>list</strong>"), "list hover should style the container type");
assert(valuesMarkdown.includes("<strong>positive integer</strong>"), "list hover should style the element type");
assert(valuesMarkdown.includes("- element:"), "list hover should include a structure element row");
const infoHover = containerHoverAnalysis.hoverAt(1, 1);
const infoMarkdown = formatInferenceMarkdown(infoHover);
assert(infoMarkdown.includes("<code>info</code>"), "record hover signature should show the variable name");
assert(infoMarkdown.includes("<strong>record</strong>"), "record hover signature should style record type");
assert(infoMarkdown.includes("<code>count</code>"), "record hover should show integer field names");
assert(infoMarkdown.includes("<strong>nonnegative integer</strong>"), "record hover should show integer field types");
assert(infoMarkdown.includes("<code>name</code>"), "record hover should show string field names");
assert(infoMarkdown.includes("<strong>string</strong>"), "record hover should show string field types");
assert(infoMarkdown.includes("<code>first</code>"), "record hover should preserve selected list element field names");
assert(infoMarkdown.includes("<strong>positive integer</strong>"), "record hover should preserve selected list element field types");

const materializedElementsSample = [
  "G := SymmetricGroup(4);",
  "elems := Elements(G);",
  "asList := AsList(G);",
  "first := elems[1];",
  ""
].join("\n");
const materializedElementsAnalysis = analyzer.analyze(materializedElementsSample, "memory://elements.g");
const elems = materializedElementsAnalysis.scopes[0].symbols.get("elems");
assert(elems && elems.type.filters.includes("IsList"), "Elements should infer a list");
assert(elems.type.element && elems.type.element.filters.includes("IsMultiplicativeElementWithInverse"), "Elements of a group should infer group elements");
const asList = materializedElementsAnalysis.scopes[0].symbols.get("asList");
assert(asList && asList.type.element && asList.type.element.filters.includes("IsMultiplicativeElementWithInverse"), "AsList of a group should infer group elements");
const firstElement = materializedElementsAnalysis.scopes[0].symbols.get("first");
assert(firstElement && firstElement.type.filters.includes("IsMultiplicativeElementWithInverse"), "indexing Elements(G) should preserve group element type");
const elemsHoverMarkdown = formatInferenceMarkdown(materializedElementsAnalysis.hoverAt(1, 1));
assert(elemsHoverMarkdown.includes("<strong>list</strong>"), "Elements hover should show list type");
assert(elemsHoverMarkdown.includes("<strong>group element</strong>"), "Elements hover should show group element structure");

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

const operatorSemanticsSample = [
  "n := 5;",
  "modValue := n mod 2;",
  "powerValue := n ^ 2;",
  "contains := 1 in [1 .. 3];",
  "negated := not contains;",
  "doubleNotNumber := not not n;",
  "badNot := not n;",
  "badMembership := 1 in n;",
  "badMod := \"hello\" mod 2;",
  "badPower := \"hello\" ^ 2;",
  "badPowerGrouping := 2 ^ 3 ^ 4;",
  ""
].join("\n");
const operatorSemanticsAnalysis = analyzer.analyze(operatorSemanticsSample, "memory://operator-semantics.g");
const operatorSemanticsScope = operatorSemanticsAnalysis.scopes[0];
const modValue = operatorSemanticsScope.symbols.get("modValue");
assert(modValue && modValue.type.filters.includes("IsInt"), "integer mod should infer an integer result");
const powerValue = operatorSemanticsScope.symbols.get("powerValue");
assert(powerValue && powerValue.type.filters.includes("IsInt"), "positive integer power should infer an integer result");
const contains = operatorSemanticsScope.symbols.get("contains");
assert(contains && contains.type.filters.includes("IsBool"), "membership should infer a boolean result");
const negated = operatorSemanticsScope.symbols.get("negated");
assert(negated && negated.type.filters.includes("IsBool"), "unary not should infer a boolean result");
const doubleNotNumber = operatorSemanticsScope.symbols.get("doubleNotNumber");
assert(doubleNotNumber && doubleNotNumber.type.filters.includes("IsInt"), "GAP even-count not should preserve the operand type");
const operatorSemanticMessages = operatorSemanticsAnalysis.diagnostics.map((diagnostic) => diagnostic.message);
assert.strictEqual(operatorSemanticMessages.length, 5, "new operator checks should report the five clear failures");
assert(operatorSemanticMessages.some((message) => message.includes("Operator not expects a boolean operand")), "not should diagnose clear non-boolean operands");
assert(operatorSemanticMessages.some((message) => message.includes("Operator in may fail")), "in should diagnose clear non-collection right operands");
assert(operatorSemanticMessages.some((message) => message.includes("Operator mod may fail")), "mod should reuse arithmetic diagnostics");
assert(operatorSemanticMessages.some((message) => message.includes("Operator ^ may fail")), "power should reuse arithmetic diagnostics");
assert(operatorSemanticMessages.some((message) => message.includes("Operator ^ is not associative")), "power should diagnose GAP's non-associative syntax");

const conditionTypeSample = [
  "conditionChecks := function(flag)",
  "    if 3 then",
  "        return 1;",
  "    elif \"bad\" then",
  "        return 2;",
  "    elif flag then",
  "        return 3;",
  "    fi;",
  "    while [1] do",
  "        return 4;",
  "    od;",
  "    repeat",
  "        marker := 1;",
  "    until 5;",
  "    return 0;",
  "end;",
  ""
].join("\n");
const conditionTypeAnalysis = analyzer.analyze(conditionTypeSample, "memory://condition-types.g");
const conditionDiagnostics = conditionTypeAnalysis.diagnostics.filter((diagnostic) => diagnostic.code === "condition-type");
assert.strictEqual(conditionDiagnostics.length, 4, "clearly non-boolean control-flow conditions should be diagnosed");
assert(conditionDiagnostics[0].message.includes("if condition may fail"), "if diagnostic should identify the condition kind");
assert(conditionDiagnostics[0].message.includes("got integer"), "if diagnostic should include the inferred type");
assert.strictEqual(conditionDiagnostics[0].range.start.line, 1, "if diagnostic should point at the condition expression");
assert(conditionDiagnostics[1].message.includes("elif condition may fail"), "elif diagnostic should identify the condition kind");
assert(conditionDiagnostics[1].message.includes("got string"), "elif diagnostic should include the inferred type");
assert.strictEqual(conditionDiagnostics[1].range.start.line, 3, "elif diagnostic should point at the condition expression");
assert(conditionDiagnostics[2].message.includes("while condition may fail"), "while diagnostic should identify the condition kind");
assert(conditionDiagnostics[2].message.includes("got list"), "while diagnostic should include the inferred type");
assert.strictEqual(conditionDiagnostics[2].range.start.line, 8, "while diagnostic should point at the condition expression");
assert(conditionDiagnostics[3].message.includes("repeat-until condition may fail"), "repeat-until diagnostic should identify the condition kind");
assert(conditionDiagnostics[3].message.includes("got integer"), "repeat-until diagnostic should include the inferred type");
assert.strictEqual(conditionDiagnostics[3].range.start.line, 13, "repeat-until diagnostic should point at the condition expression");

const selectorSample = [
  "G := SymmetricGroup(4);",
  "gens := GeneratorsOfGroup(G);",
  "first := gens[1];",
  "again := GeneratorsOfGroup(G)[1];",
  "picked := gens{[1]};",
  "str := \"abc\";",
  "ch := str[2];",
  "slice := str{[1, 3]};",
  "r := rec(count := 3, name := \"gap\");",
  "count := r.count;",
  "name := r.name;",
  "missing := r.missing;",
  "badBase := 5[1];",
  "badIndex := gens[\"x\"];",
  "badSubPositions := gens{1};",
  "badRecord := [1, 2].name;",
  ""
].join("\n");
const selectorAnalysis = analyzer.analyze(selectorSample, "memory://selectors.g");
const selectorScope = selectorAnalysis.scopes[0];
const first = selectorScope.symbols.get("first");
assert(first && first.type.filters.includes("IsMultiplicativeElementWithInverse"), "list selector should infer collection element filters");
const again = selectorScope.symbols.get("again");
assert(again && again.type.filters.includes("IsMultiplicativeElementWithInverse"), "selector inference should work after call expressions");
const picked = selectorScope.symbols.get("picked");
assert(picked && picked.type.filters.includes("IsList"), "sublist selector should infer a list result");
assert(
  picked.type.element && picked.type.element.filters.includes("IsMultiplicativeElementWithInverse"),
  "sublist selector should preserve input element filters"
);
const ch = selectorScope.symbols.get("ch");
assert(ch && ch.type.filters.includes("IsChar"), "string index selector should infer a character");
const slice = selectorScope.symbols.get("slice");
assert(slice && slice.type.filters.includes("IsString"), "string sublist selector should infer a string");
const count = selectorScope.symbols.get("count");
assert(count && count.type.filters.includes("IsInt"), "record selector should use record literal field types");
const name = selectorScope.symbols.get("name");
assert(name && name.type.filters.includes("IsString"), "record selector should preserve string field types");
const selectorMessages = selectorAnalysis.diagnostics
  .filter((diagnostic) => diagnostic.code === "selector-type")
  .map((diagnostic) => diagnostic.message);
assert.strictEqual(selectorMessages.length, 5, "selector checks should report the five clear failures");
assert(selectorMessages.some((message) => message.includes("field missing")), "record selector should diagnose unknown literal fields");
assert(selectorMessages.some((message) => message.includes("base is integer")), "list selector should diagnose non-list bases");
assert(selectorMessages.some((message) => message.includes("index is string")), "list selector should diagnose non-integer indices");
assert(selectorMessages.some((message) => message.includes("positions are integer")), "sublist selector should diagnose non-list positions");
assert(selectorMessages.some((message) => message.includes("expected a record")), "record selector should diagnose non-record bases");

const unassignedLocalSample = [
  "badLocal := function(flag)",
  "    local value, ready;",
  "    if flag then",
  "        ready := value + 1;",
  "    fi;",
  "    value := 3;",
  "    return value;",
  "end;",
  "",
  "returnBad := function()",
  "    local missing;",
  "    return missing;",
  "end;",
  "",
  "okLocal := function()",
  "    local assigned;",
  "    assigned := 1;",
  "    return assigned;",
  "end;",
  "",
  "branchAssigned := function(flag)",
  "    local value;",
  "    if flag then",
  "        value := 1;",
  "    else",
  "        value := 2;",
  "    fi;",
  "    return value;",
  "end;",
  "",
  "branchPartial := function(flag)",
  "    local partial;",
  "    if flag then",
  "        partial := 1;",
  "    fi;",
  "    return partial;",
  "end;",
  "",
  "branchWithTermination := function(flag)",
  "    local eventual;",
  "    if flag then",
  "        return fail;",
  "    else",
  "        eventual := 4;",
  "    fi;",
  "    return eventual;",
  "end;",
  ""
].join("\n");
const unassignedLocalAnalysis = analyzer.analyze(unassignedLocalSample, "memory://unassigned-local.g");
const unassignedLocalDiagnostics = unassignedLocalAnalysis.diagnostics.filter((diagnostic) => diagnostic.code === "unassigned-local");
assert.strictEqual(unassignedLocalDiagnostics.length, 3, "reads of declared locals before assignment should be diagnosed");
assert(unassignedLocalDiagnostics[0].message.includes("value"), "assignment expression diagnostic should identify the unassigned local");
assert.strictEqual(unassignedLocalDiagnostics[0].range.start.line, 3, "assignment expression diagnostic should point at the unassigned read");
assert(unassignedLocalDiagnostics[1].message.includes("missing"), "return diagnostic should identify the unassigned local");
assert.strictEqual(unassignedLocalDiagnostics[1].range.start.line, 11, "return diagnostic should point at the unassigned read");
assert(unassignedLocalDiagnostics[2].message.includes("partial"), "partial branch diagnostic should identify the unassigned local");
assert.strictEqual(unassignedLocalDiagnostics[2].range.start.line, 35, "partial branch diagnostic should point after the conditional");
const branchAssigned = unassignedLocalAnalysis.scopes[0].symbols.get("branchAssigned");
assert(branchAssigned && branchAssigned.returnType.filters.includes("IsInt"), "locals assigned on every if branch should be assigned after the conditional");
const branchWithTermination = unassignedLocalAnalysis.scopes[0].symbols.get("branchWithTermination");
assert(branchWithTermination && branchWithTermination.returnType.filters.includes("IsInt"), "terminating branches should not block definite assignment on reaching paths");

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

const forLoopSample = [
  "for i in [1 .. 4] do",
  "    bad := i + \"x\";",
  "od;",
  "",
  "G := SymmetricGroup(4);",
  "for g in GeneratorsOfGroup(G) do",
  "    item := g;",
  "od;",
  "",
  "firstValue := function()",
  "    for j in [1 .. 4] do",
  "        return j;",
  "    od;",
  "end;",
  ""
].join("\n");
const forLoopAnalysis = analyzer.analyze(forLoopSample, "memory://for-loop.g");
const forDiagnostics = forLoopAnalysis.diagnostics.filter((diagnostic) => diagnostic.code === "operator-type");
assert.strictEqual(forDiagnostics.length, 1, "invalid arithmetic inside a for loop should be diagnosed");
assert(forDiagnostics[0].message.includes("left operand is integer"), "for-loop diagnostic should use the iterator element type");
assert.strictEqual(forDiagnostics[0].range.start.line, 1, "for-loop diagnostic should point at the loop body line");
const loopHover = forLoopAnalysis.hoverAt(1, 11);
assert(loopHover && loopHover.symbol.name === "i", "hover inside a for loop should resolve the loop variable");
assert(loopHover.symbol.type.filters.includes("IsInt"), "range loop variable should infer integer element type");
const generatorHover = forLoopAnalysis.hoverAt(6, 12);
assert(generatorHover && generatorHover.symbol.name === "g", "hover inside a generator loop should resolve the loop variable");
assert(
  generatorHover.symbol.type.filters.includes("IsMultiplicativeElementWithInverse"),
  "generator loop variable should inherit the collection element filters"
);
const firstValue = forLoopAnalysis.scopes[0].symbols.get("firstValue");
assert(firstValue && firstValue.returnType.filters.includes("IsInt"), "return inside a for loop should use loop-variable flow");

const whileLoopSample = [
  "whileFlow := function(obj)",
  "    while IsString(obj) do",
  "        bad := obj + 1;",
  "        return obj;",
  "    od;",
  "    return [];",
  "end;",
  ""
].join("\n");
const whileLoopAnalysis = analyzer.analyze(whileLoopSample, "memory://while-loop.g");
const whileDiagnostics = whileLoopAnalysis.diagnostics.filter((diagnostic) => diagnostic.code === "operator-type");
assert.strictEqual(whileDiagnostics.length, 1, "invalid arithmetic inside a while loop should be diagnosed");
assert(whileDiagnostics[0].message.includes("left operand is string"), "while-loop diagnostic should use condition-refined filters");
assert.strictEqual(whileDiagnostics[0].range.start.line, 2, "while-loop diagnostic should point at the loop body line");
const whileHover = whileLoopAnalysis.hoverAt(2, 17);
assert(whileHover && whileHover.symbol.name === "obj", "hover inside a while loop should resolve the refined symbol");
assert(whileHover.symbol.type.filters.includes("IsString"), "while-loop hover should include predicate filters");
const whileFlow = whileLoopAnalysis.scopes[0].symbols.get("whileFlow");
assert(whileFlow && whileFlow.returnType.filters.includes("IsString"), "return inside a while loop should use condition flow");

const guardFlowSample = [
  "guardFlow := function(obj)",
  "    if not IsString(obj) then",
  "        return fail;",
  "    fi;",
  "    bad := obj + 1;",
  "    return obj;",
  "end;",
  ""
].join("\n");
const guardFlowAnalysis = analyzer.analyze(guardFlowSample, "memory://guard-flow.g");
const guardDiagnostics = guardFlowAnalysis.diagnostics.filter((diagnostic) => diagnostic.code === "operator-type");
assert.strictEqual(guardDiagnostics.length, 1, "post-guard invalid arithmetic should be diagnosed");
assert(guardDiagnostics[0].message.includes("left operand is string"), "post-guard diagnostic should use fallthrough predicate filters");
assert.strictEqual(guardDiagnostics[0].range.start.line, 4, "post-guard diagnostic should point after the guard");
const guardHover = guardFlowAnalysis.hoverAt(4, 12);
assert(guardHover && guardHover.symbol.name === "obj", "hover after a guard should resolve the guarded symbol");
assert(guardHover.symbol.type.filters.includes("IsString"), "hover after a guard should include fallthrough predicate filters");
const guardFlow = guardFlowAnalysis.scopes[0].symbols.get("guardFlow");
assert(guardFlow && guardFlow.returnType.filters.includes("IsString"), "return after a guard should use fallthrough flow");

const negatedBranchFlowSample = [
  "elseFlow := function(obj)",
  "    if not IsString(obj) then",
  "        return [];",
  "    else",
  "        bad := obj + 1;",
  "        return obj;",
  "    fi;",
  "end;",
  "",
  "elifFlow := function(obj)",
  "    if not IsGroup(obj) then",
  "        return [];",
  "    elif IsBool(obj) then",
  "        return obj;",
  "    else",
  "        bad := obj + 1;",
  "        return GeneratorsOfGroup(obj);",
  "    fi;",
  "end;",
  ""
].join("\n");
const negatedBranchFlowAnalysis = analyzer.analyze(negatedBranchFlowSample, "memory://negated-branch-flow.g");
const negatedBranchDiagnostics = negatedBranchFlowAnalysis.diagnostics.filter((diagnostic) => diagnostic.code === "operator-type");
assert.strictEqual(negatedBranchDiagnostics.length, 2, "false branches of negated predicates should refine later branch scopes");
assert(negatedBranchDiagnostics[0].message.includes("left operand is string"), "else branch diagnostic should use the negated-if false path");
assert.strictEqual(negatedBranchDiagnostics[0].range.start.line, 4, "else branch diagnostic should point inside the else body");
assert(negatedBranchDiagnostics[1].message.includes("left operand is group"), "elif fallthrough diagnostic should carry prior negated filter evidence");
assert.strictEqual(negatedBranchDiagnostics[1].range.start.line, 15, "elif fallthrough diagnostic should point inside the final else body");
const elseHover = negatedBranchFlowAnalysis.hoverAt(4, 16);
assert(elseHover && elseHover.symbol.name === "obj", "hover inside else should resolve the refined parameter");
assert(elseHover.symbol.type.filters.includes("IsString"), "else hover should include the negated-if false-path filter");
const elifElseHover = negatedBranchFlowAnalysis.hoverAt(15, 16);
assert(elifElseHover && elifElseHover.symbol.name === "obj", "hover inside elif final else should resolve the refined parameter");
assert(elifElseHover.symbol.type.filters.includes("IsGroup"), "elif final else hover should include earlier negated predicate evidence");
const negatedBranchCallDiagnostics = negatedBranchFlowAnalysis.diagnostics.filter((diagnostic) => diagnostic.code === "call-argument-filter");
assert.strictEqual(negatedBranchCallDiagnostics.length, 0, "prior negated branch flow should make group-only calls compatible in later branches");

const terminatingGuardSample = [
  "hardGuard := function(obj)",
  "    if not IsString(obj) then",
  "        ErrorNoReturn(\"expected string\");",
  "    fi;",
  "    bad := obj + 1;",
  "    return obj;",
  "end;",
  "",
  "methodGuard := function(obj)",
  "    if not IsGroup(obj) then",
  "        TryNextMethod();",
  "    fi;",
  "    return GeneratorsOfGroup(obj);",
  "end;",
  ""
].join("\n");
const terminatingGuardAnalysis = analyzer.analyze(terminatingGuardSample, "memory://terminating-guards.g");
const terminatingGuardOperatorDiagnostics = terminatingGuardAnalysis.diagnostics.filter((diagnostic) => diagnostic.code === "operator-type");
assert.strictEqual(terminatingGuardOperatorDiagnostics.length, 1, "ErrorNoReturn guard should refine the fallthrough path");
assert(
  terminatingGuardOperatorDiagnostics[0].message.includes("left operand is string"),
  "ErrorNoReturn guard diagnostic should use the fallthrough predicate filters"
);
const hardGuard = terminatingGuardAnalysis.scopes[0].symbols.get("hardGuard");
assert(hardGuard && hardGuard.returnType.filters.includes("IsString"), "ErrorNoReturn guard return should use fallthrough flow");
const methodGuard = terminatingGuardAnalysis.scopes[0].symbols.get("methodGuard");
assert(methodGuard && methodGuard.returnType.filters.includes("IsList"), "TryNextMethod guard should allow group-only code after the guard");
const terminatingCallDiagnostics = terminatingGuardAnalysis.diagnostics.filter((diagnostic) => diagnostic.code === "call-argument-filter");
assert.strictEqual(terminatingCallDiagnostics.length, 0, "TryNextMethod guard should prevent incompatible call diagnostics after the guard");
const methodGuardHover = terminatingGuardAnalysis.hoverAt(12, 31);
assert(methodGuardHover && methodGuardHover.symbol.name === "obj", "hover after TryNextMethod guard should resolve the guarded parameter");
assert(methodGuardHover.symbol.type.filters.includes("IsGroup"), "TryNextMethod guard hover should include fallthrough predicate filters");

const repeatUntilSample = [
  "repeatFlow := function(obj)",
  "    repeat",
  "        marker := 1;",
  "    until IsString(obj);",
  "    bad := obj + 1;",
  "    return obj;",
  "end;",
  "",
  "repeatGroup := function(obj)",
  "    repeat",
  "        marker := 1;",
  "    until IsGroup(obj);",
  "    return GeneratorsOfGroup(obj);",
  "end;",
  ""
].join("\n");
const repeatUntilAnalysis = analyzer.analyze(repeatUntilSample, "memory://repeat-until.g");
const repeatDiagnostics = repeatUntilAnalysis.diagnostics.filter((diagnostic) => diagnostic.code === "operator-type");
assert.strictEqual(repeatDiagnostics.length, 1, "repeat-until fallthrough should diagnose invalid post-loop arithmetic");
assert(repeatDiagnostics[0].message.includes("left operand is string"), "repeat-until diagnostic should use condition-refined filters");
assert.strictEqual(repeatDiagnostics[0].range.start.line, 4, "repeat-until diagnostic should point after the loop");
const repeatHover = repeatUntilAnalysis.hoverAt(4, 12);
assert(repeatHover && repeatHover.symbol.name === "obj", "hover after repeat-until should resolve the refined symbol");
assert(repeatHover.symbol.type.filters.includes("IsString"), "hover after repeat-until should include condition filters");
const repeatFlow = repeatUntilAnalysis.scopes[0].symbols.get("repeatFlow");
assert(repeatFlow && repeatFlow.returnType.filters.includes("IsString"), "return after repeat-until should use condition flow");
const repeatGroup = repeatUntilAnalysis.scopes[0].symbols.get("repeatGroup");
assert(repeatGroup && repeatGroup.returnType.filters.includes("IsList"), "group repeat-until flow should allow group-only calls after the loop");
const repeatCallDiagnostics = repeatUntilAnalysis.diagnostics.filter((diagnostic) => diagnostic.code === "call-argument-filter");
assert.strictEqual(repeatCallDiagnostics.length, 0, "repeat-until group flow should prevent incompatible call diagnostics after the loop");

const predicateCallbackSample = [
  "G := SymmetricGroup(4);",
  "gens := GeneratorsOfGroup(G);",
  "selected := Filtered(gens, g -> IsObject(g));",
  "allOk := ForAll([1 .. 4], i -> i > 0);",
  "anyBad := ForAny([1 .. 4], i -> i + 1);",
  ""
].join("\n");
const predicateCallbackAnalysis = analyzer.analyze(predicateCallbackSample, "memory://predicate-callbacks.g");
const selected = predicateCallbackAnalysis.scopes[0].symbols.get("selected");
assert(selected && selected.type.filters.includes("IsList"), "Filtered should infer a list result");
assert(
  selected.type.element && selected.type.element.filters.includes("IsMultiplicativeElementWithInverse"),
  "Filtered should preserve the input collection element type"
);
const allOk = predicateCallbackAnalysis.scopes[0].symbols.get("allOk");
assert(allOk && allOk.type.filters.includes("IsBool"), "ForAll should infer a boolean result");
const filteredHover = predicateCallbackAnalysis.hoverAt(2, 27);
assert(filteredHover && filteredHover.symbol.name === "g", "Filtered callback hover should resolve the arrow parameter");
assert(
  filteredHover.symbol.type.filters.includes("IsMultiplicativeElementWithInverse"),
  "Filtered callback parameter should inherit collection element filters"
);
const forAllHover = predicateCallbackAnalysis.hoverAt(3, 26);
assert(forAllHover && forAllHover.symbol.name === "i", "ForAll callback hover should resolve the arrow parameter");
assert(forAllHover.symbol.type.filters.includes("IsInt"), "ForAll callback parameter should use range element filters");
const callbackDiagnostics = predicateCallbackAnalysis.diagnostics.filter((diagnostic) => diagnostic.code === "callback-return-filter");
assert.strictEqual(callbackDiagnostics.length, 1, "non-boolean predicate callback bodies should be diagnosed");
assert(callbackDiagnostics[0].message.includes("ForAny callback should return a boolean"), "predicate diagnostic should identify the operation");
assert(callbackDiagnostics[0].message.includes("got integer"), "predicate diagnostic should include the callback body type");
assert.strictEqual(callbackDiagnostics[0].range.start.line, 4, "predicate diagnostic should point at the callback body line");

console.log("Analyzer tests passed.");
