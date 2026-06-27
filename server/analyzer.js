"use strict";

const { parseGapSource } = require("./parser");

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TERMINATING_CALLS = new Set(["ErrorNoReturn", "TryNextMethod"]);

const HARD_CODED_CALLS = {
  AlternatingGroup: callType("alternating permutation group", ["IsObject", "IsCollection", "IsMagma", "IsGroup", "IsPermGroup", "IsFinite"], "constructor"),
  AsGroup: callType("group", ["IsObject", "IsCollection", "IsMagma", "IsGroup"], "attribute"),
  Factorial: callType("positive integer", ["IsObject", "IsInt", "IsPosInt"], "function"),
  FreeGroup: callType("free group", ["IsObject", "IsCollection", "IsMagma", "IsGroup", "IsFreeGroup"], "constructor"),
  GeneratorsOfGroup: callType(
    "list of group generators",
    ["IsObject", "IsCollection", "IsList", "IsDenseList"],
    "attribute",
    { element: typeInfo("group element", ["IsObject", "IsMultiplicativeElementWithInverse"]) }
  ),
  Group: callType("group", ["IsObject", "IsCollection", "IsMagma", "IsGroup"], "constructor"),
  GroupWithGenerators: callType("group", ["IsObject", "IsCollection", "IsMagma", "IsGroup"], "constructor"),
  Length: callType("nonnegative integer", ["IsObject", "IsInt", "IsNonnegativeInt"], "function"),
  List: callType("list", ["IsObject", "IsCollection", "IsList"], "function"),
  Size: callType("integer or infinity", ["IsObject", "IsInt", "IsInfinity"], "attribute"),
  SymmetricGroup: callType("symmetric permutation group", ["IsObject", "IsCollection", "IsMagma", "IsGroup", "IsPermGroup", "IsFinite"], "constructor")
};

class GapAnalyzer {
  constructor(docs, declarations) {
    this.docs = docs || { entries: {}, names: [] };
    this.declarations = declarations || { declarations: {}, names: [] };
    this.docsNameSet = new Set(this.docs.names || []);
  }

  analyze(text, uri = "") {
    return analyzeGapText(text, this.docs, uri, this.declarations);
  }

  hoverAt(text, line, character, uri = "") {
    const analysis = this.analyze(text, uri);
    return analysis.hoverAt(line, character);
  }
}

function analyzeGapText(text, docs, uri = "", declarations = { declarations: {}, names: [] }) {
  const lineStarts = computeLineStarts(text);
  const masked = maskCommentsAndStrings(text);
  const ast = parseGapSource(text);
  const globalScope = createScope("global", 0, text.length, undefined);
  globalScope.lineStarts = lineStarts;
  const diagnostics = [];
  const functions = [];
  const scopes = [globalScope];
  const data = { docs, declarations, diagnostics, lineStarts, scopes };
  analyzeStatements(ast.statements, globalScope, data, functions, text, masked, lineStarts, scopes);
  refineFunctionParametersFromCallSites(text, masked, functions, globalScope, data);

  const document = {
    uri,
    text,
    ast,
    lineStarts,
    scopes,
    functions,
    diagnostics,
    hoverAt(line, character) {
      const offset = offsetAt(lineStarts, line, character);
      const word = wordAt(text, offset);
      if (!word || !IDENTIFIER_RE.test(word.text)) {
        return undefined;
      }

      const scope = innermostScopeAt(this.scopes, offset);
      const symbol = lookupSymbol(scope, word.text);
      if (symbol) {
        return {
          kind: "symbol",
          word,
          symbol,
          scope
        };
      }

      const documented = documentedCallableInfo(word.text, data);
      if (documented) {
        return {
          kind: "documented",
          word,
          symbol: documented,
          scope
        };
      }

      return undefined;
    }
  };

  return document;
}

function analyzeStatements(statements, scope, data, functions, text, masked, lineStarts, scopes) {
  let activeScope = scope;

  for (const statement of statements) {
    statement.analysisScope = activeScope;

    if (statement.type === "localDeclaration") {
      analyzeLocalDeclarationNode(statement, activeScope, lineStarts);
      continue;
    }

    if (statement.type === "functionAssignment") {
      analyzeFunctionAssignmentNode(statement, activeScope, data, functions, text, masked, lineStarts, scopes);
      continue;
    }

    if (statement.type === "assignment") {
      analyzeAssignmentNode(statement, activeScope, data, lineStarts);
      continue;
    }

    if (statement.type === "expressionStatement") {
      inferExpression(statement.expression.text, activeScope, data, statement.expression.start);
      continue;
    }

    if (statement.type === "ifStatement") {
      analyzeIfStatementNode(statement, activeScope, data, functions, text, masked, lineStarts, scopes);
      activeScope = guardFallthroughScope(statement, activeScope, data, lineStarts, scopes) || activeScope;
      continue;
    }

    if (statement.type === "forStatement") {
      analyzeForStatementNode(statement, activeScope, data, functions, text, masked, lineStarts, scopes);
      continue;
    }

    if (statement.type === "whileStatement") {
      analyzeWhileStatementNode(statement, activeScope, data, functions, text, masked, lineStarts, scopes);
      continue;
    }

    if (statement.type === "repeatStatement") {
      analyzeRepeatStatementNode(statement, activeScope, data, functions, text, masked, lineStarts, scopes);
      activeScope = repeatFallthroughScope(statement, data, lineStarts, scopes) || activeScope;
      continue;
    }

    for (const nestedStatements of nestedStatementLists(statement)) {
      analyzeStatements(nestedStatements, activeScope, data, functions, text, masked, lineStarts, scopes);
    }
  }
}

function analyzeLocalDeclarationNode(statement, scope, lineStarts) {
  for (const name of statement.names || []) {
    if (!IDENTIFIER_RE.test(name.name)) {
      continue;
    }
    scope.symbols.set(name.name, {
      name: name.name,
      scope: "local",
      range: rangeFromOffset(lineStarts, name.start),
      type: typeInfo("unknown local", ["IsObject"], { confidence: "unknown" }),
      source: "local declaration"
    });
  }
}

function analyzeAssignmentNode(statement, scope, data, lineStarts) {
  if (!IDENTIFIER_RE.test(statement.name)) {
    return;
  }

  const expression = statement.expression || { text: "", start: statement.assignStart + 2 };
  const inferred = inferExpression(expression.text, scope, data, expression.start);
  scope.symbols.set(statement.name, {
    name: statement.name,
    scope: scope.kind === "global" ? "global" : "local",
    range: rangeFromOffset(lineStarts, statement.nameStart),
    type: inferred,
    source: expression.text
  });
}

function analyzeFunctionAssignmentNode(statement, parentScope, data, functions, text, masked, lineStarts, scopes) {
  if (!IDENTIFIER_RE.test(statement.name)) {
    return;
  }

  const scope = createScope(`function ${statement.name}`, statement.start, statement.end, parentScope);
  scope.lineStarts = lineStarts;
  scopes.push(scope);
  const paramSymbols = (statement.params || []).map((param) => ({
    name: param.name,
    scope: "parameter",
    range: rangeFromOffset(lineStarts, param.start),
    type: typeInfo("unknown parameter", ["IsObject"], { confidence: "unknown" }),
    source: "function parameter"
  }));

  for (const paramSymbol of paramSymbols) {
    if (IDENTIFIER_RE.test(paramSymbol.name)) {
      scope.symbols.set(paramSymbol.name, paramSymbol);
    }
  }

  analyzeStatements(statement.body || [], scope, data, functions, text, masked, lineStarts, scopes);
  refineSymbolsFromCallArgumentFilters(
    text.slice(statement.bodyStart, statement.bodyEnd),
    masked.slice(statement.bodyStart, statement.bodyEnd),
    scope,
    data,
    statement.bodyStart
  );
  const returnType = inferReturnTypeFromStatements(statement.body || [], scope, data);
  const fnType = functionType(paramSymbols.map((parameter) => parameter.name), returnType, {
    parameterTypes: paramSymbols.map((parameter) => parameter.type)
  });

  const functionSymbol = {
    name: statement.name,
    scope: parentScope.kind === "global" ? "global" : "local",
    range: rangeFromOffset(lineStarts, statement.nameStart),
    type: fnType,
    source: "function definition",
    parameters: paramSymbols,
    returnType
  };
  parentScope.symbols.set(statement.name, functionSymbol);

  functions.push({
    name: statement.name,
    start: statement.start,
    end: statement.end,
    scope,
    symbol: functionSymbol,
    parameters: paramSymbols,
    returnType
  });
}

function analyzeIfStatementNode(statement, parentScope, data, functions, text, masked, lineStarts, scopes) {
  const fallthroughRefinements = [];

  for (const branch of statement.branches || []) {
    const scope = createBranchScope("if branch", branch.body || [], parentScope, lineStarts, branch.condition);
    branch.scope = scope;
    scopes.push(scope);
    applyRefinementsToScope(fallthroughRefinements, scope, branch.condition ? branch.condition.start : statement.start);
    if (branch.condition && branch.condition.text) {
      inferExpression(branch.condition.text, parentScope, data, branch.condition.start);
    }
    applyPredicateRefinements(branch.condition && branch.condition.text, scope, data, branch.condition && branch.condition.start);
    analyzeStatements(branch.body || [], scope, data, functions, text, masked, lineStarts, scopes);
    fallthroughRefinements.push(...negatedPredicateRefinements(branch.condition && branch.condition.text, data));
  }

  if (statement.elseBody && statement.elseBody.length > 0) {
    const scope = createBranchScope("else branch", statement.elseBody, parentScope, lineStarts);
    statement.elseScope = scope;
    scopes.push(scope);
    applyRefinementsToScope(fallthroughRefinements, scope, statement.elseBody[0].start);
    analyzeStatements(statement.elseBody, scope, data, functions, text, masked, lineStarts, scopes);
  }
}

function guardFallthroughScope(statement, parentScope, data, lineStarts, scopes) {
  const refinements = guardFallthroughRefinements(statement, data);
  if (refinements.length === 0) {
    return undefined;
  }

  const scope = createScope("guarded flow", statement.end, parentScope.end, parentScope);
  scope.lineStarts = lineStarts;
  scope.guard = statement.branches[0].condition && statement.branches[0].condition.text;
  applyRefinementsToScope(refinements, scope, statement.end);
  statement.fallthroughScope = scope;
  scopes.push(scope);
  return scope;
}

function guardFallthroughRefinements(statement, data) {
  if (
    !statement ||
    statement.type !== "ifStatement" ||
    !Array.isArray(statement.branches) ||
    statement.branches.length !== 1 ||
    (statement.elseBody && statement.elseBody.length > 0)
  ) {
    return [];
  }

  const branch = statement.branches[0];
  if (!statementsTerminate(branch.body || [])) {
    return [];
  }

  return negatedPredicateRefinements(branch.condition && branch.condition.text, data);
}

function statementsTerminate(statements) {
  if (!Array.isArray(statements) || statements.length === 0) {
    return false;
  }
  return statementTerminates(statements[statements.length - 1]);
}

function statementTerminates(statement) {
  if (!statement) {
    return false;
  }
  if (statement.type === "returnStatement") {
    return true;
  }
  if (statement.type === "expressionStatement") {
    return isTerminatingExpression(statement.expression && statement.expression.text);
  }
  if (statement.type === "ifStatement") {
    return Boolean(
      statement.elseBody &&
      statement.elseBody.length > 0 &&
      (statement.branches || []).every((branch) => statementsTerminate(branch.body || [])) &&
      statementsTerminate(statement.elseBody)
    );
  }
  return false;
}

function isTerminatingExpression(expressionText) {
  const call = parseCallExpression((expressionText || "").trim());
  return Boolean(call && TERMINATING_CALLS.has(call.name));
}

function analyzeForStatementNode(statement, parentScope, data, functions, text, masked, lineStarts, scopes) {
  const iteratorType = statement.iterator
    ? inferExpression(statement.iterator.text, parentScope, data, statement.iterator.start)
    : typeInfo("unknown collection", ["IsObject"], { confidence: "unknown" });
  const loopScope = createLoopScope(statement, parentScope, lineStarts);
  statement.scope = loopScope;
  scopes.push(loopScope);

  bindLoopVariable(statement, loopScope, iteratorType, lineStarts);
  analyzeStatements(statement.body || [], loopScope, data, functions, text, masked, lineStarts, scopes);
}

function analyzeWhileStatementNode(statement, parentScope, data, functions, text, masked, lineStarts, scopes) {
  if (statement.condition && statement.condition.text) {
    inferExpression(statement.condition.text, parentScope, data, statement.condition.start);
  }

  const scope = createPredicateLoopScope("while loop", statement, parentScope, lineStarts);
  statement.scope = scope;
  scopes.push(scope);
  applyPredicateRefinements(statement.condition && statement.condition.text, scope, data, statement.condition && statement.condition.start);
  analyzeStatements(statement.body || [], scope, data, functions, text, masked, lineStarts, scopes);
}

function analyzeRepeatStatementNode(statement, parentScope, data, functions, text, masked, lineStarts, scopes) {
  const scope = createPredicateLoopScope("repeat loop", statement, parentScope, lineStarts);
  statement.scope = scope;
  scopes.push(scope);
  analyzeStatements(statement.body || [], scope, data, functions, text, masked, lineStarts, scopes);

  if (statement.condition && statement.condition.text) {
    inferExpression(statement.condition.text, scope, data, statement.condition.start);
  }
}

function repeatFallthroughScope(statement, data, lineStarts, scopes) {
  const refinements = predicateRefinements(statement.condition && statement.condition.text, data);
  if (refinements.length === 0) {
    return undefined;
  }

  const parentScope = statement.scope || statement.analysisScope;
  if (!parentScope) {
    return undefined;
  }

  const enclosingEnd = parentScope.parent ? parentScope.parent.end : parentScope.end;
  const scope = createScope("repeat fallthrough", statement.end, enclosingEnd, parentScope);
  scope.lineStarts = lineStarts;
  scope.condition = statement.condition && statement.condition.text;
  applyRefinementsToScope(refinements, scope, statement.condition ? statement.condition.start : statement.end);
  statement.fallthroughScope = scope;
  scopes.push(scope);
  return scope;
}

function createLoopScope(statement, parentScope, lineStarts) {
  const first = statement.body && statement.body[0];
  const last = statement.body && statement.body[statement.body.length - 1];
  const fallbackStart = statement.iterator ? statement.iterator.end : statement.start;
  const scope = createScope("for loop", first ? first.start : fallbackStart, last ? last.end : fallbackStart, parentScope);
  scope.lineStarts = lineStarts;
  scope.iterator = statement.iterator && statement.iterator.text;
  return scope;
}

function bindLoopVariable(statement, loopScope, iteratorType, lineStarts) {
  if (!statement.variable || !IDENTIFIER_RE.test(statement.variable.text)) {
    return;
  }

  const elementType = (iteratorType && iteratorType.element) ||
    elementTypeFromCollection(iteratorType) ||
    typeInfo("collection element", ["IsObject"], { confidence: "unknown" });

  loopScope.symbols.set(statement.variable.text, {
    name: statement.variable.text,
    scope: "loop variable",
    range: rangeFromOffset(lineStarts, statement.variable.start),
    type: elementType,
    source: statement.iterator ? `for ${statement.iterator.text}` : "for loop"
  });
}

function createPredicateLoopScope(kind, statement, parentScope, lineStarts) {
  const first = statement.body && statement.body[0];
  const last = statement.body && statement.body[statement.body.length - 1];
  const fallbackStart = statement.condition ? statement.condition.end : statement.start;
  const scope = createScope(kind, first ? first.start : fallbackStart, last ? last.end : fallbackStart, parentScope);
  scope.lineStarts = lineStarts;
  scope.condition = statement.condition && statement.condition.text;
  return scope;
}

function createBranchScope(kind, statements, parentScope, lineStarts, condition) {
  const first = statements[0];
  const last = statements[statements.length - 1];
  const fallbackStart = condition ? condition.end : parentScope.start;
  const start = first ? first.start : fallbackStart;
  const end = last ? last.end : fallbackStart;
  const scope = createScope(kind, start, end, parentScope);
  scope.lineStarts = lineStarts;
  scope.condition = condition && condition.text;
  return scope;
}

function applyPredicateRefinements(conditionText, scope, data, conditionOffset = 0) {
  applyRefinementsToScope(predicateRefinements(conditionText, data), scope, conditionOffset);
}

function applyRefinementsToScope(refinements, scope, offset = 0) {
  for (const refinement of refinements) {
    const existing = lookupSymbol(scope.parent, refinement.name);
    const symbol = existing
      ? cloneSymbolForScope(existing)
      : {
          name: refinement.name,
          scope: scope.parent && scope.parent.kind === "global" ? "global" : "local",
          range: rangeFromOffset(scope.lineStarts, offset),
          type: typeInfo("unknown GAP object", ["IsObject"], { confidence: "unknown" }),
          source: "predicate"
        };
    refineSymbolWithFlowFilters(symbol, refinement.filters, refinement.source);
    scope.symbols.set(refinement.name, symbol);
  }
}

function negatedPredicateRefinements(conditionText, data) {
  const expression = stripBalancedParens((conditionText || "").trim());
  if (!/^not\b/.test(expression)) {
    return [];
  }

  const rawRest = expression.replace(/^not\b/, "").trim();
  if (!rawRest) {
    return [];
  }

  const parenthesized = rawRest.startsWith("(") && rawRest.endsWith(")") && enclosesWholeExpression(rawRest);
  if (!parenthesized && (splitLogicalAnd(rawRest).length > 1 || splitByTopLevelWordOperator(rawRest, "or").length > 1)) {
    return [];
  }

  return predicateRefinements(stripBalancedParens(rawRest), data);
}

function predicateRefinements(conditionText, data) {
  const expression = stripBalancedParens((conditionText || "").trim());
  if (!expression) {
    return [];
  }

  const parts = splitLogicalAnd(expression);
  const refinements = [];
  for (const part of parts) {
    const term = stripBalancedParens(part.trim());
    if (/^not\b/.test(term)) {
      continue;
    }
    const call = parseCallExpression(term);
    if (!call || call.args.length !== 1 || !IDENTIFIER_RE.test(call.args[0].trim())) {
      continue;
    }
    if (!isPositiveFilterPredicate(call.name, data)) {
      continue;
    }
    refinements.push({
      name: call.args[0].trim(),
      filters: ["IsObject", call.name],
      source: `${call.name}(...)`
    });
  }
  return refinements;
}

function isPositiveFilterPredicate(name, data) {
  if (!/^Is[A-Z]/.test(name)) {
    return false;
  }

  const declaration = declarationCallableInfo(name, data.declarations || { declarations: {}, names: [] });
  if (!declaration || !declaration.type || declaration.type.declarations.length === 0) {
    return true;
  }

  return declaration.type.declarations.some((candidate) =>
    ["category", "filter", "property"].includes(candidate.kind)
  );
}

function splitLogicalAnd(expression) {
  return splitByTopLevelWordOperator(expression, "and");
}

function splitByTopLevelWordOperator(expression, operator) {
  const parts = [];
  let start = 0;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < expression.length; index += 1) {
    const char = expression[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") {
      depth += 1;
      continue;
    }
    if (char === ")" || char === "]" || char === "}") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0) {
      continue;
    }

    if (
      expression.slice(index, index + operator.length) === operator &&
      hasWordBoundaries(expression, index, index + operator.length)
    ) {
      parts.push(expression.slice(start, index));
      start = index + operator.length;
      index = start - 1;
    }
  }

  parts.push(expression.slice(start));
  return parts;
}

function stripBalancedParens(expression) {
  let result = expression.trim();
  while (result.startsWith("(") && result.endsWith(")") && enclosesWholeExpression(result)) {
    result = result.slice(1, -1).trim();
  }
  return result;
}

function enclosesWholeExpression(expression) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < expression.length; index += 1) {
    const char = expression[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0 && index < expression.length - 1) {
        return false;
      }
    }
    if (depth < 0) {
      return false;
    }
  }

  return depth === 0;
}

function cloneSymbolForScope(symbol) {
  return {
    ...symbol,
    type: cloneType(symbol.type),
    parameters: Array.isArray(symbol.parameters) ? [...symbol.parameters] : symbol.parameters,
    returnType: symbol.returnType ? cloneType(symbol.returnType) : symbol.returnType
  };
}

function refineSymbolWithFlowFilters(symbol, filters, source) {
  const existing = symbol.type || typeInfo("unknown", ["IsObject"], { confidence: "unknown" });
  const mergedFilters = sortedUnique([...(existing.filters || []), ...filters]);
  const label = /^unknown /.test(existing.label || "") ? labelFromFilters(mergedFilters, "flow-refined object") : existing.label;
  symbol.type = typeInfo(label, mergedFilters, {
    confidence: "flow",
    element: existing.element,
    parameterTypes: existing.parameterTypes,
    parameters: existing.parameters,
    returnType: existing.returnType,
    source
  });
}

function labelFromFilters(filters, fallback) {
  if (filters.includes("IsString")) {
    return "string";
  }
  if (filters.includes("IsBool")) {
    return "boolean";
  }
  if (filters.includes("IsInt") || filters.includes("IsPosInt") || filters.includes("IsNonnegativeInt")) {
    return "integer";
  }
  if (filters.includes("IsRat")) {
    return "rational";
  }
  if (filters.includes("IsPermGroup")) {
    return "permutation group";
  }
  if (filters.includes("IsGroup")) {
    return "group";
  }
  if (filters.includes("IsPerm")) {
    return "permutation";
  }
  if (filters.includes("IsList")) {
    return "list";
  }
  if (filters.includes("IsRecord")) {
    return "record";
  }
  if (filters.includes("IsFunction")) {
    return "function";
  }
  return fallback;
}

function inferReturnTypeFromStatements(statements, scope, data) {
  let returnType;

  for (const statement of statements) {
    let inferred;
    const statementScope = statement.analysisScope || scope;
    if (statement.type === "returnStatement") {
      const expression = statement.expression;
      inferred = expression
        ? inferExpression(expression.text, statementScope, data, expression.start)
        : typeInfo("no return value", ["IsObject"], { confidence: "inferred" });
    } else if (statement.type === "ifStatement") {
      inferred = inferIfReturnType(statement, statementScope, data);
    } else if (statement.type === "forStatement") {
      const nested = inferReturnTypeFromStatements(statement.body || [], statement.scope || statementScope, data);
      if (nested.label !== "no return value") {
        inferred = nested;
      }
    } else if (statement.type === "whileStatement") {
      const nested = inferReturnTypeFromStatements(statement.body || [], statement.scope || statementScope, data);
      if (nested.label !== "no return value") {
        inferred = nested;
      }
    } else if (statement.type === "repeatStatement") {
      const nested = inferReturnTypeFromStatements(statement.body || [], statement.scope || statementScope, data);
      if (nested.label !== "no return value") {
        inferred = nested;
      }
    } else {
      for (const nestedStatements of nestedStatementLists(statement)) {
        const nested = inferReturnTypeFromStatements(nestedStatements, statementScope, data);
        if (nested.label !== "no return value") {
          inferred = inferred ? mergeTypeInfo(inferred, nested) : nested;
        }
      }
    }

    if (inferred) {
      returnType = returnType ? mergeTypeInfo(returnType, inferred) : inferred;
    }
  }

  return returnType || typeInfo("no return value", ["IsObject"], { confidence: "inferred" });
}

function inferIfReturnType(statement, fallbackScope, data) {
  let returnType;

  for (const branch of statement.branches || []) {
    const branchType = inferReturnTypeFromStatements(branch.body || [], branch.scope || fallbackScope, data);
    if (branchType.label !== "no return value") {
      returnType = returnType ? mergeTypeInfo(returnType, branchType) : branchType;
    }
  }

  if (statement.elseBody && statement.elseBody.length > 0) {
    const elseType = inferReturnTypeFromStatements(statement.elseBody, statement.elseScope || fallbackScope, data);
    if (elseType.label !== "no return value") {
      returnType = returnType ? mergeTypeInfo(returnType, elseType) : elseType;
    }
  }

  return returnType;
}

function nestedStatementLists(statement) {
  if (statement.type === "ifStatement") {
    return [
      ...(statement.branches || []).map((branch) => branch.body || []),
      statement.elseBody || []
    ];
  }
  if (statement.type === "forStatement" || statement.type === "whileStatement" || statement.type === "repeatStatement") {
    return [statement.body || []];
  }
  return [];
}

function parseFunctionAssignments(text, masked, lineStarts, globalScope, data) {
  const functions = [];
  const regex = /\b([A-Za-z_][A-Za-z0-9_]*)\s*:=\s*function\s*\(([^)]*)\)/g;
  let match;

  while ((match = regex.exec(masked)) !== null) {
    const name = match[1];
    const params = splitCommaList(match[2]);
    const bodyStart = regex.lastIndex;
    const end = findMatchingFunctionEnd(masked, bodyStart);
    if (end < 0) {
      continue;
    }

    const body = text.slice(bodyStart, end);
    const scope = createScope(`function ${name}`, match.index, end + 4, globalScope);
    scope.lineStarts = lineStarts;
    const paramSymbols = params.map((param) => ({
      name: param,
      scope: "parameter",
      range: rangeFromOffset(lineStarts, match.index + match[0].indexOf(param)),
      type: typeInfo("unknown parameter", ["IsObject"], { confidence: "unknown" }),
      source: "function parameter"
    }));

    for (const paramSymbol of paramSymbols) {
      scope.symbols.set(paramSymbol.name, paramSymbol);
    }

    parseLocalDeclarations(body, bodyStart, lineStarts, scope);
    parseAssignments(text.slice(bodyStart, end), masked.slice(bodyStart, end), scope, data, [], bodyStart);
    refineSymbolsFromCallArgumentFilters(body, masked.slice(bodyStart, end), scope, data, bodyStart);
    const returnType = inferReturnType(body, bodyStart, scope, data);
    const fnType = functionType(params, returnType, {
      parameterTypes: paramSymbols.map((parameter) => parameter.type)
    });

    const functionSymbol = {
      name,
      scope: "global",
      range: rangeFromOffset(lineStarts, match.index),
      type: fnType,
      source: "function definition",
      parameters: paramSymbols,
      returnType
    };
    globalScope.symbols.set(name, functionSymbol);

    functions.push({
      name,
      start: match.index,
      end: end + 4,
      scope,
      symbol: functionSymbol,
      parameters: paramSymbols,
      returnType
    });
  }

  return functions;
}

function parseAssignments(text, masked, scope, data, excludedRanges = [], baseOffset = 0) {
  const regex = /\b([A-Za-z_][A-Za-z0-9_]*)\s*:=\s*([^;]+);/g;
  let match;

  while ((match = regex.exec(masked)) !== null) {
    const absoluteStart = baseOffset + match.index;
    if (isInExcludedRange(absoluteStart, excludedRanges)) {
      continue;
    }

    const name = match[1];
    const assignmentIndex = match[0].indexOf(":=");
    const expressionStart = match.index + assignmentIndex + 2;
    const expressionEnd = match.index + match[0].length - 1;
    const expressionText = text.slice(expressionStart, expressionEnd);
    const expressionWhitespace = leadingWhitespaceLength(expressionText);
    const rawExpression = expressionText.trim();
    if (/^function\s*\(/.test(rawExpression)) {
      continue;
    }

    const inferred = inferExpression(rawExpression, scope, data, baseOffset + expressionStart + expressionWhitespace);
    scope.symbols.set(name, {
      name,
      scope: scope.kind === "global" ? "global" : "local",
      range: rangeFromOffset(scope.lineStarts || computeLineStarts(text), baseOffset + match.index),
      type: inferred,
      source: rawExpression
    });
  }
}

function refineSymbolsFromCallArgumentFilters(text, masked, scope, data, baseOffset = 0) {
  for (const call of findCalls(text, masked, baseOffset)) {
    const callable = documentedCallableInfo(call.name, data);
    const parameterTypes = callable && callable.type && callable.type.parameterTypes;
    if (!parameterTypes || parameterTypes.length === 0) {
      continue;
    }

    call.args.forEach((argument, index) => {
      const parameterType = parameterTypes[index];
      if (!parameterType || !parameterType.filters || parameterType.filters.length === 0) {
        return;
      }

      const argumentName = argument.trim();
      if (!IDENTIFIER_RE.test(argumentName)) {
        return;
      }

      const symbol = lookupSymbol(scope, argumentName);
      if (!symbol) {
        return;
      }

      refineSymbolWithExpectedFilters(symbol, parameterType.filters, `${call.name} argument ${index + 1}`);
    });
  }
}

function refineFunctionParametersFromCallSites(text, masked, functions, globalScope, data) {
  if (functions.length === 0) {
    return;
  }

  for (const call of findCalls(text, masked, 0)) {
    const fn = functions.find((candidate) => candidate.name === call.name);
    if (!fn || isInExcludedRange(call.start, functions.map((candidate) => [candidate.start, candidate.end]))) {
      continue;
    }

    call.args.forEach((argument, index) => {
      const parameter = fn.parameters[index];
      if (!parameter) {
        return;
      }

      const argumentType = inferExpression(argument, globalScope, data);
      if (!argumentType || !argumentType.filters || argumentType.filters.length === 0 || argumentType.confidence === "unknown") {
        return;
      }
      if (isClearlyIncompatibleWithExpectedFilters(argumentType, parameter.type && parameter.type.filters)) {
        return;
      }

      refineSymbolWithExpectedFilters(parameter, argumentType.filters, `${call.name} call argument ${index + 1}`);
    });

    fn.symbol.type = functionType(fn.parameters.map((parameter) => parameter.name), fn.returnType, {
      parameterTypes: fn.parameters.map((parameter) => parameter.type)
    });
  }
}

function refineSymbolWithExpectedFilters(symbol, filters, source) {
  const existing = symbol.type || typeInfo("unknown", ["IsObject"], { confidence: "unknown" });
  const canRefine = symbol.scope === "parameter" || existing.confidence === "unknown" || /^unknown /.test(existing.label || "");
  if (!canRefine) {
    return;
  }

  const mergedFilters = sortedUnique([...(existing.filters || []), ...filters]);
  const label = symbol.scope === "parameter" ? "parameter" : existing.label;
  symbol.type = typeInfo(label, mergedFilters, {
    confidence: existing.confidence === "unknown" ? "call context" : "merged",
    source
  });
}

function parseLocalDeclarations(body, bodyOffset, lineStarts, scope) {
  const regex = /\blocal\s+([^;]+);/g;
  let match;

  while ((match = regex.exec(body)) !== null) {
    for (const name of splitCommaList(match[1])) {
      if (!IDENTIFIER_RE.test(name)) {
        continue;
      }
      scope.symbols.set(name, {
        name,
        scope: "local",
        range: rangeFromOffset(lineStarts, bodyOffset + match.index + match[0].indexOf(name)),
        type: typeInfo("unknown local", ["IsObject"], { confidence: "unknown" }),
        source: "local declaration"
      });
    }
  }
}

function inferReturnType(body, bodyOffset, scope, data) {
  const regex = /\breturn\s+([^;]+);/g;
  let returnType;
  let match;

  while ((match = regex.exec(maskCommentsAndStrings(body))) !== null) {
    const returnIndex = match[0].indexOf("return");
    const expressionStart = match.index + returnIndex + "return".length;
    const expressionEnd = match.index + match[0].length - 1;
    const expressionText = body.slice(expressionStart, expressionEnd);
    const expressionWhitespace = leadingWhitespaceLength(expressionText);
    const expression = expressionText.trim();
    const offset = bodyOffset + expressionStart + expressionWhitespace;
    returnType = returnType ? mergeTypeInfo(returnType, inferExpression(expression, scope, data, offset)) : inferExpression(expression, scope, data, offset);
  }

  return returnType || typeInfo("no return value", ["IsObject"], { confidence: "inferred" });
}

function inferExpression(expression, scope, data, expressionOffset = 0) {
  const expr = expression.trim();
  if (!expr) {
    return typeInfo("unknown", ["IsObject"], { confidence: "unknown" });
  }

  if (/^(true|false)$/.test(expr)) {
    return typeInfo("boolean", ["IsObject", "IsBool"], { confidence: "literal" });
  }
  if (expr === "fail") {
    return typeInfo("fail", ["IsObject"], { confidence: "literal" });
  }
  if (/^-?\d+$/.test(expr)) {
    const value = Number.parseInt(expr, 10);
    const filters = ["IsObject", "IsInt"];
    if (value >= 0) {
      filters.push("IsNonnegativeInt");
    }
    if (value > 0) {
      filters.push("IsPosInt");
    }
    return typeInfo("integer", filters, { confidence: "literal" });
  }
  if (/^-?\d+\s*\/\s*-?\d+$/.test(expr)) {
    return typeInfo("rational", ["IsObject", "IsRat"], { confidence: "literal" });
  }
  if (/^'(?:\\.|[^'\\])'$/.test(expr)) {
    return typeInfo("character", ["IsObject", "IsChar"], { confidence: "literal" });
  }
  if (/^"(?:\\.|[^"\\])*"$/.test(expr)) {
    return typeInfo("string", ["IsObject", "IsString", "IsList"], { confidence: "literal" });
  }
  const selector = parseSelectorExpression(expr);
  if (selector) {
    return inferSelectorExpression(selector, scope, data, expressionOffset);
  }
  if (/^\[.*\]$/.test(expr)) {
    const element = inferListElementType(expr, scope, data, expressionOffset);
    return typeInfo("list", ["IsObject", "IsCollection", "IsList"], { confidence: "literal", element });
  }
  if (/^rec\s*\(/.test(expr)) {
    return inferRecordLiteralType(expr, scope, data, expressionOffset);
  }
  if (/^\([^)]*(?:,\s*\d+)+\)$/.test(expr)) {
    return typeInfo("permutation", ["IsObject", "IsPerm"], { confidence: "literal" });
  }
  const unwrapped = stripBalancedParens(expr);
  if (unwrapped !== expr) {
    return inferExpression(unwrapped, scope, data, expressionOffset + expr.indexOf(unwrapped));
  }
  const binary = parseBinaryExpression(expr);
  if (binary) {
    return inferBinaryExpression(binary, scope, data, expressionOffset);
  }
  const unaryNot = parseUnaryNotExpression(expr);
  if (unaryNot) {
    return inferUnaryNotExpression(unaryNot, scope, data, expressionOffset);
  }
  const call = parseCallExpression(expr);
  if (call) {
    return inferCall(call.name, call.args, scope, data, expressionOffset, call.argumentSpans);
  }

  if (/^function\s*\(/.test(expr) || /->/.test(expr)) {
    return typeInfo("function", ["IsObject", "IsFunction"], { confidence: "literal" });
  }

  const symbol = lookupSymbol(scope, expr);
  if (symbol) {
    return symbol.type;
  }

  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(expr)) {
    const documented = documentedCallableInfo(expr, data);
    if (documented) {
      return documented.type;
    }
  }

  return typeInfo("unknown GAP object", ["IsObject"], { confidence: "unknown" });
}

function inferListElementType(expr, scope, data, expressionOffset = 0) {
  const inside = expr.slice(1, -1).trim();
  if (!inside) {
    return undefined;
  }
  if (/\.\./.test(inside)) {
    return typeInfo("integer", ["IsObject", "IsInt"], { confidence: "range literal" });
  }

  const parts = splitCommaList(inside);
  if (parts.length === 0 || parts.length > 8) {
    return undefined;
  }

  let searchOffset = 1;
  return parts.map((part) => {
    const partIndex = expr.indexOf(part, searchOffset);
    if (partIndex >= 0) {
      searchOffset = partIndex + part.length;
    }
    return inferExpression(part, scope, data, partIndex >= 0 ? expressionOffset + partIndex : expressionOffset);
  }).reduce(mergeTypeInfo);
}

function inferRecordLiteralType(expr, scope, data, expressionOffset = 0) {
  const match = /^rec\s*\(([\s\S]*)\)$/.exec(expr);
  if (!match) {
    return typeInfo("record", ["IsObject", "IsRecord"], { confidence: "literal" });
  }

  const openIndex = expr.indexOf("(");
  const fields = {};
  for (const span of splitTopLevelWithSpans(match[1], ",")) {
    const fieldMatch = /^\s*([A-Za-z_][A-Za-z0-9_]*|\d+)\s*:=\s*([\s\S]+?)\s*$/.exec(span.text);
    if (!fieldMatch) {
      continue;
    }
    const name = fieldMatch[1];
    const valueStartInSpan = span.text.indexOf(fieldMatch[2]);
    fields[name] = inferExpression(
      fieldMatch[2],
      scope,
      data,
      expressionOffset + openIndex + 1 + span.start + valueStartInSpan
    );
  }

  return typeInfo("record", ["IsObject", "IsRecord"], {
    confidence: "literal",
    fields
  });
}

function inferSelectorExpression(selector, scope, data, expressionOffset) {
  const baseType = inferExpression(selector.base, scope, data, expressionOffset + selector.baseStart);

  if (selector.kind === "index") {
    return inferIndexSelector(selector, baseType, scope, data, expressionOffset);
  }

  if (selector.kind === "sublist") {
    return inferSublistSelector(selector, baseType, scope, data, expressionOffset);
  }

  if (selector.kind === "record") {
    return inferRecordSelector(selector, baseType, data, expressionOffset);
  }

  return typeInfo("unknown selected value", ["IsObject"], { confidence: "selector" });
}

function inferIndexSelector(selector, baseType, scope, data, expressionOffset) {
  const argument = selector.arguments[0] || { text: "", start: selector.selectorStart + 1 };
  const indexType = inferExpression(argument.text, scope, data, expressionOffset + argument.start);

  if (isClearlyInvalidListSelectorBase(baseType)) {
    reportDiagnostic(
      data,
      expressionOffset + selector.selectorStart,
      1,
      `List selector may fail: base is ${formatTypeLabel(baseType)}, expected a list or string.`,
      { code: "selector-type", severity: 2 }
    );
  }

  if (isClearlyInvalidListIndex(indexType)) {
    reportDiagnostic(
      data,
      expressionOffset + argument.start,
      Math.max(1, argument.text.length),
      `List selector may fail: index is ${formatTypeLabel(indexType)}, expected an integer.`,
      { code: "selector-type", severity: 2 }
    );
  }

  if (hasAnyFilter(baseType, ["IsString"])) {
    return typeInfo("character", ["IsObject", "IsChar"], { confidence: "selector", source: "string[index]" });
  }

  return (baseType && baseType.element) || typeInfo("list element", ["IsObject"], { confidence: "selector" });
}

function inferSublistSelector(selector, baseType, scope, data, expressionOffset) {
  const positions = selector.arguments[0] || { text: "", start: selector.selectorStart + 1 };
  const positionsType = inferExpression(positions.text, scope, data, expressionOffset + positions.start);

  if (isClearlyInvalidListSelectorBase(baseType)) {
    reportDiagnostic(
      data,
      expressionOffset + selector.selectorStart,
      1,
      `Sublist selector may fail: base is ${formatTypeLabel(baseType)}, expected a list or string.`,
      { code: "selector-type", severity: 2 }
    );
  }

  if (isClearlyInvalidPositionList(positionsType)) {
    reportDiagnostic(
      data,
      expressionOffset + positions.start,
      Math.max(1, positions.text.length),
      `Sublist selector may fail: positions are ${formatTypeLabel(positionsType)}, expected a list of positive integers.`,
      { code: "selector-type", severity: 2 }
    );
  }

  if (hasAnyFilter(baseType, ["IsString"])) {
    return typeInfo("string", ["IsObject", "IsString", "IsList"], { confidence: "selector", source: "string{positions}" });
  }

  return typeInfo("list", ["IsObject", "IsCollection", "IsList"], {
    confidence: "selector",
    source: "list{positions}",
    element: baseType && baseType.element
  });
}

function inferRecordSelector(selector, baseType, data, expressionOffset) {
  if (isClearlyInvalidRecordSelectorBase(baseType)) {
    reportDiagnostic(
      data,
      expressionOffset + selector.selectorStart,
      1,
      `Record selector may fail: base is ${formatTypeLabel(baseType)}, expected a record.`,
      { code: "selector-type", severity: 2 }
    );
  }

  if (baseType && baseType.fields && Object.prototype.hasOwnProperty.call(baseType.fields, selector.field)) {
    return baseType.fields[selector.field];
  }

  if (baseType && baseType.fields && !Object.prototype.hasOwnProperty.call(baseType.fields, selector.field)) {
    reportDiagnostic(
      data,
      expressionOffset + selector.fieldStart,
      Math.max(1, selector.field.length),
      `Record selector may fail: field ${selector.field} is not known on this record literal.`,
      { code: "selector-type", severity: 2 }
    );
  }

  return typeInfo(`record field ${selector.field}`, ["IsObject"], { confidence: "selector" });
}

function parseSelectorExpression(expr) {
  const bracketSelector = parseTrailingBracketSelector(expr, "]", "[", "index")
    || parseTrailingBracketSelector(expr, "}", "{", "sublist");
  if (bracketSelector) {
    return bracketSelector;
  }

  return parseTrailingRecordSelector(expr);
}

function parseTrailingBracketSelector(expr, close, open, kind) {
  if (!expr.endsWith(close)) {
    return undefined;
  }

  const openIndex = findMatchingOpeningDelimiter(expr, expr.length - 1, open, close);
  if (openIndex <= 0) {
    return undefined;
  }

  const base = expr.slice(0, openIndex).trimEnd();
  if (!isSelectorBaseCandidate(base)) {
    return undefined;
  }

  const inside = expr.slice(openIndex + 1, -1);
  const argumentsWithSpans = splitTopLevelWithSpans(inside, ",").map((span) => {
    const leading = leadingWhitespaceLength(span.text);
    const trailing = span.text.length - span.text.trimEnd().length;
    return {
      text: span.text.trim(),
      start: openIndex + 1 + span.start + leading,
      end: openIndex + 1 + span.end - trailing
    };
  }).filter((span) => span.text);

  return {
    kind,
    base,
    baseStart: 0,
    selectorStart: openIndex,
    arguments: argumentsWithSpans
  };
}

function parseTrailingRecordSelector(expr) {
  if (/^\d+\.\d+$/.test(expr)) {
    return undefined;
  }

  const dotIndex = findTrailingRecordDot(expr);
  if (dotIndex <= 0) {
    return undefined;
  }

  const field = expr.slice(dotIndex + 1);
  if (!/^(?:[A-Za-z_][A-Za-z0-9_]*|\d+)$/.test(field)) {
    return undefined;
  }

  const base = expr.slice(0, dotIndex).trimEnd();
  if (!isSelectorBaseCandidate(base)) {
    return undefined;
  }

  return {
    kind: "record",
    base,
    baseStart: 0,
    selectorStart: dotIndex,
    field,
    fieldStart: dotIndex + 1
  };
}

function findMatchingOpeningDelimiter(expr, closeIndex, open, close) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = closeIndex; index >= 0; index -= 1) {
    const char = expr[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === close) {
      depth += 1;
      continue;
    }
    if (char === open) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function findTrailingRecordDot(expr) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = expr.length - 1; index >= 0; index -= 1) {
    const char = expr[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === ")" || char === "]" || char === "}") {
      depth += 1;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0) {
      continue;
    }
    if (char === "." && expr[index - 1] !== "." && expr[index + 1] !== ".") {
      return index;
    }
  }

  return -1;
}

function isSelectorBaseCandidate(base) {
  if (!base) {
    return false;
  }
  if (/[+\-*/^=<>]$/.test(base) || /\b(?:and|in|mod|not|or)$/.test(base)) {
    return false;
  }
  return !parseBinaryExpression(base) && !parseUnaryNotExpression(base);
}

function inferBinaryExpression(binary, scope, data, expressionOffset) {
  const operatorOffset = expressionOffset + binary.operatorStart;
  if (binary.nonAssociative) {
    reportDiagnostic(
      data,
      operatorOffset,
      binary.operator.length,
      `Operator ${binary.operator} is not associative in GAP; add parentheses to choose the grouping.`
    );
    return typeInfo(`invalid ${binary.operator} expression`, ["IsObject"], { confidence: "syntax" });
  }

  const leftType = inferExpression(binary.left, scope, data, expressionOffset + binary.leftStart);
  const rightType = inferExpression(binary.right, scope, data, expressionOffset + binary.rightStart);

  if (["+", "-", "*", "/", "mod", "^"].includes(binary.operator)) {
    if (isNumericType(leftType) && isNumericType(rightType)) {
      return numericBinaryResult(binary.operator, leftType, rightType);
    }

    if (isClearlyInvalidArithmeticOperand(leftType) || isClearlyInvalidArithmeticOperand(rightType)) {
      reportDiagnostic(
        data,
        operatorOffset,
        binary.operator.length,
        `Operator ${binary.operator} may fail: left operand is ${formatTypeLabel(leftType)}, right operand is ${formatTypeLabel(rightType)}.`
      );
      return typeInfo(`unknown result of ${binary.operator}`, ["IsObject"], { confidence: "operator" });
    }

    return typeInfo(`unknown result of ${binary.operator}`, ["IsObject"], { confidence: "operator" });
  }

  if (binary.operator === "in") {
    if (isClearlyInvalidMembershipContainer(rightType)) {
      reportDiagnostic(
        data,
        operatorOffset,
        binary.operator.length,
        `Operator in may fail: right operand is ${formatTypeLabel(rightType)}, expected a list or collection.`
      );
    }
    return typeInfo("boolean", ["IsObject", "IsBool"], { confidence: "operator" });
  }

  if (["=", "<>", "<", "<=", ">", ">="].includes(binary.operator)) {
    return typeInfo("boolean", ["IsObject", "IsBool"], { confidence: "operator" });
  }

  if (["and", "or"].includes(binary.operator)) {
    if (isClearlyNonBoolean(leftType) || isClearlyNonBoolean(rightType)) {
      reportDiagnostic(
        data,
        operatorOffset,
        binary.operator.length,
        `Operator ${binary.operator} expects boolean operands; got ${formatTypeLabel(leftType)} and ${formatTypeLabel(rightType)}.`
      );
    }
    return typeInfo("boolean", ["IsObject", "IsBool"], { confidence: "operator" });
  }

  return typeInfo(`unknown result of ${binary.operator}`, ["IsObject"], { confidence: "operator" });
}

function inferUnaryNotExpression(unary, scope, data, expressionOffset) {
  const operandType = inferExpression(unary.operand, scope, data, expressionOffset + unary.operandStart);
  if (unary.count % 2 === 0) {
    return operandType;
  }

  if (isClearlyNonBoolean(operandType)) {
    reportDiagnostic(
      data,
      expressionOffset + unary.operatorStart,
      "not".length,
      `Operator not expects a boolean operand; got ${formatTypeLabel(operandType)}.`
    );
  }

  return typeInfo("boolean", ["IsObject", "IsBool"], { confidence: "operator" });
}

function numericBinaryResult(operator, leftType, rightType) {
  if (operator === "/" || hasAnyFilter(leftType, ["IsRat"]) || hasAnyFilter(rightType, ["IsRat"])) {
    return typeInfo("rational", ["IsObject", "IsRat"], { confidence: "operator" });
  }
  if (operator === "^" && !hasAnyFilter(rightType, ["IsPosInt", "IsNonnegativeInt"])) {
    return typeInfo("number", ["IsObject", "IsRat"], { confidence: "operator" });
  }
  return typeInfo("integer", ["IsObject", "IsInt"], { confidence: "operator" });
}

function parseBinaryExpression(expr) {
  const groups = [
    ["or"],
    ["and"],
    ["<>", "<=", ">=", "=", "<", ">", "in"],
    ["+", "-"],
    ["*", "/", "mod"],
    ["^"]
  ];

  for (const operators of groups) {
    const found = findTopLevelOperator(expr, operators);
    if (!found) {
      continue;
    }

    const left = expr.slice(0, found.index).trim();
    const right = expr.slice(found.index + found.operator.length).trim();
    if (!left || !right) {
      continue;
    }

    return {
      operator: found.operator,
      operatorStart: found.index,
      left,
      leftStart: leadingWhitespaceLength(expr.slice(0, found.index)),
      right,
      rightStart: found.index + found.operator.length + leadingWhitespaceLength(expr.slice(found.index + found.operator.length)),
      nonAssociative: found.operator === "^" && topLevelOperatorCount(expr, "^") > 1
    };
  }

  return undefined;
}

function parseUnaryNotExpression(expr) {
  let index = 0;
  let count = 0;
  let firstOperatorStart;

  while (expr.slice(index).startsWith("not") && hasWordBoundaries(expr, index, index + "not".length)) {
    if (firstOperatorStart === undefined) {
      firstOperatorStart = index;
    }
    count += 1;
    index += "not".length;
    index += leadingWhitespaceLength(expr.slice(index));
  }

  if (count === 0) {
    return undefined;
  }

  const operand = expr.slice(index).trim();
  if (!operand) {
    return undefined;
  }

  return {
    operatorStart: firstOperatorStart,
    count,
    operand,
    operandStart: index + leadingWhitespaceLength(expr.slice(index))
  };
}

function findTopLevelOperator(expr, operators) {
  const sortedOperators = [...operators].sort((left, right) => right.length - left.length);
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = expr.length - 1; index >= 0; index -= 1) {
    const char = expr[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === ")" || char === "]" || char === "}") {
      depth += 1;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0) {
      continue;
    }

    for (const operator of sortedOperators) {
      const start = index - operator.length + 1;
      if (start < 0 || expr.slice(start, index + 1) !== operator) {
        continue;
      }
      if (isWordOperator(operator) && !hasWordBoundaries(expr, start, index + 1)) {
        continue;
      }
      if ((operator === "+" || operator === "-") && isUnarySign(expr, start)) {
        continue;
      }
      return {
        operator,
        index: start
      };
    }
  }

  return undefined;
}

function topLevelOperatorCount(expr, operator) {
  let count = 0;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < expr.length; index += 1) {
    const char = expr[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") {
      depth += 1;
      continue;
    }
    if (char === ")" || char === "]" || char === "}") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0) {
      continue;
    }

    if (expr.slice(index, index + operator.length) === operator) {
      count += 1;
      index += operator.length - 1;
    }
  }

  return count;
}

function isWordOperator(operator) {
  return /^[A-Za-z]+$/.test(operator);
}

function hasWordBoundaries(text, start, end) {
  return !/[A-Za-z0-9_]/.test(text[start - 1] || "") && !/[A-Za-z0-9_]/.test(text[end] || "");
}

function isUnarySign(expr, index) {
  const before = expr.slice(0, index).trimEnd();
  return !before || /(?:[([{,=<>+\-*/^]|:=)$/.test(before) || /\b(?:and|in|mod|not|or)$/.test(before);
}

function isNumericType(type) {
  return hasAnyFilter(type, ["IsInt", "IsRat", "IsFloat", "IsCyc", "IsCyclotomic"]);
}

function isClearlyInvalidArithmeticOperand(type) {
  if (!type || type.confidence === "unknown") {
    return false;
  }
  return hasAnyFilter(type, [
    "IsString",
    "IsBool",
    "IsRecord",
    "IsFunction",
    "IsPerm",
    "IsGroup",
    "IsPermGroup"
  ]);
}

function isClearlyNonBoolean(type) {
  return type && type.confidence !== "unknown" && !hasAnyFilter(type, ["IsBool"]);
}

function isClearlyInvalidMembershipContainer(type) {
  if (!type || type.confidence === "unknown") {
    return false;
  }
  if (hasAnyFilter({ filters: [...expandedFilters(type.filters || [])] }, ["IsListOrCollection", "IsCollection", "IsList", "IsDenseList", "IsString"])) {
    return false;
  }
  return hasAnyConcreteFamily(new Set([...expandedFilters(type.filters || [])].map(filterFamily).filter(Boolean)));
}

function isClearlyInvalidListSelectorBase(type) {
  if (!type || type.confidence === "unknown") {
    return false;
  }
  if (hasAnyFilter(type, ["IsList", "IsDenseList", "IsString"])) {
    return false;
  }
  return hasAnyConcreteFamily(new Set([...expandedFilters(type.filters || [])].map(filterFamily).filter(Boolean)));
}

function isClearlyInvalidListIndex(type) {
  if (!type || type.confidence === "unknown") {
    return false;
  }
  return !hasAnyFilter({ filters: [...expandedFilters(type.filters || [])] }, ["IsInt"]);
}

function isClearlyInvalidPositionList(type) {
  if (!type || type.confidence === "unknown") {
    return false;
  }
  if (!hasAnyFilter(type, ["IsList", "IsDenseList"])) {
    return hasAnyConcreteFamily(new Set([...expandedFilters(type.filters || [])].map(filterFamily).filter(Boolean)));
  }
  if (type.element && isClearlyInvalidListIndex(type.element)) {
    return true;
  }
  return false;
}

function isClearlyInvalidRecordSelectorBase(type) {
  if (!type || type.confidence === "unknown") {
    return false;
  }
  if (hasAnyFilter(type, ["IsRecord"])) {
    return false;
  }
  return hasAnyConcreteFamily(new Set([...expandedFilters(type.filters || [])].map(filterFamily).filter(Boolean)));
}

function hasAnyFilter(type, filters) {
  const typeFilters = new Set((type && type.filters) || []);
  return filters.some((filter) => typeFilters.has(filter));
}

function reportDiagnostic(data, offset, length, message, options = {}) {
  if (!data || !Array.isArray(data.diagnostics) || !Array.isArray(data.lineStarts)) {
    return;
  }

  data.diagnostics.push({
    severity: options.severity || 1,
    source: "gap-reference-assistant",
    code: options.code || "operator-type",
    message,
    range: {
      start: rangeFromOffset(data.lineStarts, offset),
      end: rangeFromOffset(data.lineStarts, offset + Math.max(1, length))
    }
  });
}

function inferCall(name, args, scope, data, expressionOffset = 0, argumentSpans = []) {
  const local = lookupSymbol(scope, name);
  if (local && local.returnType) {
    reportUserFunctionCallDiagnostics(name, args, scope, data, expressionOffset, argumentSpans, local);
    return local.returnType;
  }

  const documented = documentedCallableInfo(name, data);
  const hardCoded = HARD_CODED_CALLS[name];
  if (documented) {
    reportCallArgumentDiagnostics(name, args, scope, data, expressionOffset, argumentSpans, documented);
  }

  if (["List", "Filtered", "ForAll", "ForAny"].includes(name)) {
    return inferHigherOrderCollectionCall(name, args, scope, data, expressionOffset, argumentSpans);
  }

  if (hardCoded) {
    return addCallContext(hardCoded(), name, args, scope);
  }

  if (/^(Is|Has|Can)[A-Z]/.test(name)) {
    return typeInfo("boolean", ["IsObject", "IsBool"], {
      confidence: "name convention",
      source: `${name}(...)`
    });
  }

  if (documented) {
    return documented.returnType || documented.type;
  }

  return typeInfo("unknown return value", ["IsObject"], {
    confidence: "unknown",
    source: `${name}(...)`
  });
}

function inferHigherOrderCollectionCall(name, args, scope, data, expressionOffset, argumentSpans) {
  const collectionSpan = argumentSpans[0] || { start: 0 };
  const collectionType = args[0]
    ? inferExpression(args[0], scope, data, expressionOffset + collectionSpan.start)
    : typeInfo("unknown collection", ["IsObject"], { confidence: "unknown" });
  const collectionElement = collectionType && collectionType.element;
  const baseElement = collectionElement || elementTypeFromCollection(collectionType);
  const mapper = args[1] ? parseArrowFunctionExpression(args[1]) : undefined;

  if (!mapper) {
    return higherOrderResultType(name, baseElement, undefined, args, scope);
  }

  const { bodyType } = inferArrowCallback(args[1], mapper, baseElement, scope, data, expressionOffset, argumentSpans[1], `${name} callback parameter`);
  if (["Filtered", "ForAll", "ForAny"].includes(name)) {
    reportPredicateCallbackDiagnostic(name, mapper, bodyType, data, expressionOffset, argumentSpans[1] || { start: 0 });
  }

  return higherOrderResultType(name, baseElement, bodyType, args, scope);
}

function higherOrderResultType(name, collectionElement, bodyType, args, scope) {
  if (name === "List") {
    return typeInfo("list", ["IsObject", "IsCollection", "IsList"], {
      confidence: "function",
      source: "List(...)",
      element: bodyType || collectionElement,
      arguments: callArguments(args, scope)
    });
  }

  if (name === "Filtered") {
    return typeInfo("list", ["IsObject", "IsCollection", "IsList"], {
      confidence: "Filtered predicate",
      source: "Filtered(...)",
      element: collectionElement,
      arguments: callArguments(args, scope)
    });
  }

  if (name === "ForAll" || name === "ForAny") {
    return typeInfo("boolean", ["IsObject", "IsBool"], {
      confidence: `${name} predicate`,
      source: `${name}(...)`,
      arguments: callArguments(args, scope)
    });
  }

  return typeInfo("GAP object", ["IsObject"], { confidence: "unknown", source: `${name}(...)` });
}

function inferArrowCallback(argumentText, mapper, firstParameterType, scope, data, expressionOffset, mapperSpan, parameterSource) {
  const span = mapperSpan || { start: 0, end: argumentText.length };
  const mapperScope = createScope("arrow function", expressionOffset + span.start, expressionOffset + span.end, scope);
  mapperScope.lineStarts = data.lineStarts;
  if (Array.isArray(data.scopes)) {
    data.scopes.push(mapperScope);
  }

  mapper.params.forEach((param, index) => {
    const paramType = index === 0
      ? (firstParameterType || typeInfo("collection element", ["IsObject"], { confidence: "unknown" }))
      : typeInfo("unknown parameter", ["IsObject"], { confidence: "unknown" });
    mapperScope.symbols.set(param.name, {
      name: param.name,
      scope: "parameter",
      range: rangeFromOffset(data.lineStarts, expressionOffset + span.start + param.start),
      type: paramType,
      source: parameterSource
    });
  });

  const bodyType = inferExpression(mapper.body, mapperScope, data, expressionOffset + span.start + mapper.bodyStart);
  return { scope: mapperScope, bodyType };
}

function reportPredicateCallbackDiagnostic(name, mapper, bodyType, data, expressionOffset, mapperSpan) {
  if (!isClearlyNonBoolean(bodyType)) {
    return;
  }

  reportDiagnostic(
    data,
    expressionOffset + mapperSpan.start + mapper.bodyStart,
    Math.max(1, mapper.body.length),
    `${name} callback should return a boolean; got ${formatTypeLabel(bodyType)}.`,
    { code: "callback-return-filter", severity: 2 }
  );
}

function parseArrowFunctionExpression(expression) {
  const found = findTopLevelOperator(expression, ["->"]);
  if (!found) {
    return undefined;
  }

  const paramsText = expression.slice(0, found.index).trim();
  const bodyText = expression.slice(found.index + found.operator.length).trim();
  if (!paramsText || !bodyText) {
    return undefined;
  }

  const unwrappedParams = stripBalancedParens(paramsText);
  const paramParts = splitCommaList(unwrappedParams);
  const params = [];
  for (const part of paramParts) {
    const name = part.trim();
    if (!IDENTIFIER_RE.test(name)) {
      return undefined;
    }
    const start = expression.indexOf(name);
    params.push({ name, start, end: start + name.length });
  }

  const rawBodyStart = found.index + found.operator.length;
  return {
    params,
    body: bodyText,
    bodyStart: rawBodyStart + leadingWhitespaceLength(expression.slice(rawBodyStart))
  };
}

function elementTypeFromCollection(collectionType) {
  if (!collectionType) {
    return undefined;
  }
  if (hasAnyFilter(collectionType, ["IsString"])) {
    return typeInfo("character", ["IsObject"], { confidence: "string element" });
  }
  if (hasAnyFilter(collectionType, ["IsList", "IsDenseList", "IsCollection"])) {
    return typeInfo("collection element", ["IsObject"], { confidence: "collection" });
  }
  return undefined;
}

function callArguments(args, scope) {
  return args.map((arg) => ({
    expression: arg,
    type: inferExpression(arg, scope, { docs: { entries: {}, names: [] }, declarations: { declarations: {}, names: [] } })
  }));
}

function reportUserFunctionCallDiagnostics(name, args, scope, data, expressionOffset, argumentSpans, symbol) {
  const parameterTypes = userFunctionParameterTypes(symbol);
  if (!Array.isArray(parameterTypes) || parameterTypes.length === 0) {
    return;
  }

  args.forEach((argument, index) => {
    const expected = parameterTypes[index];
    if (!expected || !expected.type || !expected.type.filters || expected.type.filters.length === 0) {
      return;
    }

    const span = argumentSpans[index] || { text: argument, start: 0, end: argument.length };
    const actual = inferExpression(argument, scope, data, expressionOffset + span.start);
    if (!isClearlyIncompatibleWithExpectedFilters(actual, expected.type.filters)) {
      return;
    }

    const parameterName = expected.name || `arg${index + 1}`;
    reportDiagnostic(
      data,
      expressionOffset + span.start,
      Math.max(1, span.text.trim().length),
      `${name} argument ${index + 1} may fail: inferred parameter ${parameterName} expects ${formatFilterExpectation(expected.type.filters)}, got ${formatTypeLabel(actual)}.`,
      { code: "user-call-argument-filter", severity: 2 }
    );
  });
}

function userFunctionParameterTypes(symbol) {
  if (Array.isArray(symbol.parameters) && symbol.parameters.length > 0) {
    return symbol.parameters.map((parameter, index) => ({
      name: parameter.name || `arg${index + 1}`,
      type: parameter.type
    }));
  }

  const type = symbol.type || {};
  if (Array.isArray(type.parameterTypes) && type.parameterTypes.length > 0) {
    return type.parameterTypes.map((parameterType, index) => ({
      name: type.parameters && type.parameters[index] ? type.parameters[index] : `arg${index + 1}`,
      type: parameterType
    }));
  }

  return [];
}

function reportCallArgumentDiagnostics(name, args, scope, data, expressionOffset, argumentSpans, callable) {
  const parameterTypes = callable && callable.type && callable.type.parameterTypes;
  if (!Array.isArray(parameterTypes) || parameterTypes.length === 0) {
    return;
  }

  args.forEach((argument, index) => {
    const expected = parameterTypes[index];
    if (!expected || !expected.filters || expected.filters.length === 0) {
      return;
    }

    const span = argumentSpans[index] || { text: argument, start: 0, end: argument.length };
    const actual = inferExpression(argument, scope, data, expressionOffset + span.start);
    if (!isClearlyIncompatibleWithExpectedFilters(actual, expected.filters)) {
      return;
    }

    reportDiagnostic(
      data,
      expressionOffset + span.start,
      Math.max(1, span.text.trim().length),
      `${name} argument ${index + 1} may fail: expected ${formatFilterExpectation(expected.filters)}, got ${formatTypeLabel(actual)}.`,
      { code: "call-argument-filter", severity: 2 }
    );
  });
}

function isClearlyIncompatibleWithExpectedFilters(actual, expectedFilters) {
  if (!Array.isArray(expectedFilters) || expectedFilters.length === 0) {
    return false;
  }
  if (!actual || actual.confidence === "unknown" || !Array.isArray(actual.filters) || actual.filters.length === 0) {
    return false;
  }

  const meaningfulExpectedFilters = expectedFilters.filter((filter) => filter !== "IsObject");
  if (meaningfulExpectedFilters.length === 0) {
    return false;
  }

  const actualFilters = expandedFilters(actual.filters);
  if (meaningfulExpectedFilters.some((filter) => actualFilters.has(filter))) {
    return false;
  }

  const expectedFamilies = new Set(meaningfulExpectedFilters.map(filterFamily).filter(Boolean));
  if (expectedFamilies.size === 0) {
    return false;
  }

  const actualFamilies = new Set([...actualFilters].map(filterFamily).filter(Boolean));
  for (const family of expectedFamilies) {
    if (actualFamilies.has(family)) {
      return false;
    }
  }

  return hasAnyConcreteFamily(actualFamilies);
}

function expandedFilters(filters) {
  const expanded = new Set(filters || []);

  if (expanded.has("IsPermGroup")) {
    expanded.add("IsGroup");
    expanded.add("IsMagmaWithInverses");
    expanded.add("IsCollection");
    expanded.add("IsListOrCollection");
  }
  if (expanded.has("IsGroup")) {
    expanded.add("IsMagmaWithInverses");
    expanded.add("IsMagma");
    expanded.add("IsCollection");
    expanded.add("IsListOrCollection");
  }
  if (expanded.has("IsMagmaWithInverses")) {
    expanded.add("IsMagma");
    expanded.add("IsCollection");
  }
  if (expanded.has("IsString")) {
    expanded.add("IsList");
    expanded.add("IsListOrCollection");
  }
  if (expanded.has("IsList") || expanded.has("IsDenseList")) {
    expanded.add("IsListOrCollection");
  }
  if (expanded.has("IsCollection")) {
    expanded.add("IsListOrCollection");
  }
  if (expanded.has("IsPosInt") || expanded.has("IsNonnegativeInt")) {
    expanded.add("IsInt");
  }
  if (expanded.has("IsInt")) {
    expanded.add("IsRat");
  }

  return expanded;
}

function filterFamily(filter) {
  if (["IsInt", "IsPosInt", "IsNonnegativeInt", "IsRat", "IsFloat", "IsCyc", "IsCyclotomic"].includes(filter)) {
    return "number";
  }
  if (["IsBool"].includes(filter)) {
    return "boolean";
  }
  if (["IsString"].includes(filter)) {
    return "string";
  }
  if (["IsList", "IsDenseList", "IsListOrCollection"].includes(filter)) {
    return "list-or-collection";
  }
  if (["IsCollection"].includes(filter)) {
    return "list-or-collection";
  }
  if (["IsGroup", "IsPermGroup", "IsMagma", "IsMagmaWithInverses"].includes(filter)) {
    return "magma";
  }
  if (["IsPerm"].includes(filter)) {
    return "permutation";
  }
  if (["IsRecord"].includes(filter)) {
    return "record";
  }
  if (["IsFunction"].includes(filter)) {
    return "function";
  }
  return undefined;
}

function hasAnyConcreteFamily(families) {
  return [...families].some(Boolean);
}

function formatFilterExpectation(filters) {
  return filters.map((filter) => `\`${filter}\``).join(", ");
}

function addCallContext(type, name, args, scope) {
  const enriched = cloneType(type);
  enriched.source = `${name}(...)`;
  enriched.arguments = args.map((arg) => ({
    expression: arg,
    type: inferExpression(arg, scope, { docs: { entries: {}, names: [] }, declarations: { declarations: {}, names: [] } })
  }));
  return enriched;
}

function documentedCallableInfo(name, data) {
  const docs = data.docs || data;
  const entries = docs && docs.entries && docs.entries[name];
  const declarations = data.declarations || { declarations: {}, names: [] };
  const declarationInfo = declarationCallableInfo(name, declarations);
  if (!entries || entries.length === 0) {
    return declarationInfo;
  }

  const entry = entries[0];
  const returnType = inferReturnFromEntry(entry);
  return {
    name,
    scope: "documented global",
    type: functionType(signatureParameters(entry.signature), returnType, {
      label: `${entry.kind || "documented"} ${name}`,
      signatures: entries.map((candidate) => candidate.signature).filter(Boolean),
      documentation: returnSummary(entry),
      parameterTypes: declarationInfo && declarationInfo.type && declarationInfo.type.parameterTypes,
      declarations: declarationInfo && declarationInfo.type && declarationInfo.type.declarations
    }),
    returnType,
    source: "GAP reference manual",
    documentation: returnSummary(entry)
  };
}

function declarationCallableInfo(name, declarations) {
  const resolved = resolveDeclarations(name, declarations);
  if (resolved.length === 0) {
    return undefined;
  }

  const primary = resolved.find((declaration) => Array.isArray(declaration.argumentFilters)) || resolved[0];
  const returnType = returnTypeFromDeclaration(primary);
  const parameterTypes = normalizeArgumentFilterGroups(primary.argumentFilters).map((filters, index) =>
    typeInfo(`argument ${index + 1}`, filters, { confidence: "GAP declaration" })
  );

  return {
    name,
    scope: "declared global",
    type: functionType(parameterTypes.map((_, index) => `arg${index + 1}`), returnType, {
      label: `${primary.kind || "declared"} ${name}`,
      confidence: "GAP declaration",
      parameterTypes,
      declarations: resolved
    }),
    returnType,
    source: "GAP library declarations"
  };
}

function normalizeArgumentFilterGroups(argumentFilters) {
  if (!Array.isArray(argumentFilters)) {
    return [];
  }
  if (argumentFilters.every((filter) => typeof filter === "string")) {
    return [argumentFilters];
  }
  return argumentFilters.map((filters) => Array.isArray(filters) ? filters : [filters]).filter((filters) => filters.length > 0);
}

function resolveDeclarations(name, declarations, seen = new Set()) {
  if (!declarations || !declarations.declarations || seen.has(name)) {
    return [];
  }
  seen.add(name);

  const direct = declarations.declarations[name] || [];
  const resolved = [...direct];
  for (const declaration of direct) {
    if (declaration.target) {
      resolved.push(...resolveDeclarations(declaration.target, declarations, seen));
    }
  }

  return resolved;
}

function returnTypeFromDeclaration(declaration) {
  const kind = declaration.kind || "declared";
  if (kind === "property" || kind === "category" || kind === "filter") {
    return typeInfo("boolean", ["IsObject", "IsBool"], { confidence: "GAP declaration kind" });
  }
  if (kind === "global function" || kind === "operation" || kind === "attribute" || kind === "constructor") {
    return typeInfo("GAP object", ["IsObject"], { confidence: "GAP declaration" });
  }
  return typeInfo("GAP object", ["IsObject"], { confidence: "GAP declaration" });
}

function inferReturnFromEntry(entry) {
  const kind = (entry.kind || "").toLowerCase();
  const text = returnSummary(entry).toLowerCase();

  if (kind === "property" || kind === "category" || /^is[A-Z]/.test(entry.name || "")) {
    return typeInfo("boolean", ["IsObject", "IsBool"], { confidence: "documentation kind" });
  }
  if (kind === "attribute" && /^generators/i.test(entry.name || "")) {
    return typeInfo("list", ["IsObject", "IsCollection", "IsList"], { confidence: "documentation name" });
  }
  if (/\b(list|lists|generators)\b/.test(text)) {
    return typeInfo("list", ["IsObject", "IsCollection", "IsList"], { confidence: "documentation prose" });
  }
  if (/\b(group|subgroup|coset)\b/.test(text)) {
    const filters = ["IsObject", "IsCollection", "IsMagma", "IsGroup"];
    if (/\b(permutation|symmetric|alternating)\b/.test(text)) {
      filters.push("IsPermGroup");
    }
    return typeInfo("group", filters, { confidence: "documentation prose" });
  }
  if (/\b(integer|number|length|size)\b/.test(text)) {
    return typeInfo("integer", ["IsObject", "IsInt"], { confidence: "documentation prose" });
  }
  if (/\b(string|character)\b/.test(text)) {
    return typeInfo("string", ["IsObject", "IsString", "IsList"], { confidence: "documentation prose" });
  }
  if (/\b(function)\b/.test(text)) {
    return typeInfo("function", ["IsObject", "IsFunction"], { confidence: "documentation prose" });
  }

  return typeInfo("GAP object", ["IsObject"], { confidence: "documentation" });
}

function returnSummary(entry) {
  const blocks = Array.isArray(entry.blocks) ? entry.blocks : [];
  const paragraph = blocks.find((block) => block.type === "paragraph" && block.markdown);
  return markdownToPlainText((paragraph && paragraph.markdown) || entry.description || "");
}

function parseCallExpression(expr) {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(([\s\S]*)\)$/.exec(expr);
  if (!match) {
    return undefined;
  }

  const openIndex = expr.indexOf("(");
  const spans = splitTopLevelWithSpans(match[2], ",").map((span) => {
    const leading = leadingWhitespaceLength(span.text);
    const trailing = span.text.length - span.text.trimEnd().length;
    return {
      text: span.text.trim(),
      start: openIndex + 1 + span.start + leading,
      end: openIndex + 1 + span.end - trailing
    };
  }).filter((span) => span.text);

  return {
    name: match[1],
    args: spans.map((span) => span.text),
    argumentSpans: spans
  };
}

function findCalls(text, masked, baseOffset = 0) {
  const calls = [];
  const regex = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  let match;

  while ((match = regex.exec(masked)) !== null) {
    const name = match[1];
    if (["function", "if", "for", "while", "repeat", "return"].includes(name)) {
      continue;
    }

    const openIndex = match.index + match[0].lastIndexOf("(");
    const closeIndex = findMatchingParen(masked, openIndex);
    if (closeIndex < 0) {
      continue;
    }

    calls.push({
      name,
      start: baseOffset + match.index,
      end: baseOffset + closeIndex + 1,
      args: splitCommaList(text.slice(openIndex + 1, closeIndex))
    });
  }

  return calls;
}

function findMatchingParen(masked, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < masked.length; index += 1) {
    const char = masked[index];
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function signatureParameters(signature) {
  if (!signature) {
    return [];
  }
  const match = /^[^(]+\(([\s\S]*)\)$/.exec(signature);
  return match ? splitCommaList(match[1]).map((param) => param.replace(/[\[\]]/g, "").trim()).filter(Boolean) : [];
}

function functionType(parameters, returnType, options = {}) {
  return typeInfo(options.label || "function", ["IsObject", "IsFunction"], {
    confidence: options.confidence || "inferred",
    parameters,
    returnType,
    signatures: options.signatures,
    documentation: options.documentation,
    parameterTypes: options.parameterTypes,
    declarations: options.declarations
  });
}

function typeInfo(label, filters = [], options = {}) {
  return {
    label,
    filters: sortedUnique(filters),
    family: options.family,
    element: options.element,
    parameters: options.parameters || [],
    returnType: options.returnType,
    fields: options.fields,
    signatures: options.signatures || [],
    documentation: options.documentation,
    parameterTypes: options.parameterTypes || [],
    declarations: options.declarations || [],
    confidence: options.confidence || "inferred",
    source: options.source
  };
}

function callType(label, filters, confidence, options = {}) {
  return () => typeInfo(label, filters, { ...options, confidence });
}

function cloneType(type) {
  return {
    ...type,
    filters: [...(type.filters || [])],
    parameters: [...(type.parameters || [])],
    fields: type.fields ? { ...type.fields } : undefined,
    signatures: [...(type.signatures || [])]
  };
}

function mergeTypeInfo(left, right) {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }

  return typeInfo(
    left.label === right.label ? left.label : `${left.label} | ${right.label}`,
    [...(left.filters || []), ...(right.filters || [])],
    {
      confidence: left.confidence === right.confidence ? left.confidence : "merged",
      element: left.element || right.element,
      fields: left.fields || right.fields
    }
  );
}

function formatInferenceMarkdown(hover) {
  if (!hover || !hover.symbol) {
    return "";
  }

  const symbol = hover.symbol;
  const type = symbol.returnType ? symbol.type : symbol.type;
  const displayName = symbol.name || hover.word.text;
  const lines = ["### GAP inference", ""];
  const summary = [codeSpan(displayName)];
  if (symbol.scope) {
    summary.push(`_${escapeMarkdown(scopeLabel(symbol.scope))}_`);
  }
  summary.push(codeSpan(formatTypeLabel(type)));
  lines.push(summary.join(" · "), "");

  appendTypeDetails(lines, type);

  if (symbol.returnType) {
    lines.push(`**Returns** ${codeSpan(formatTypeLabel(symbol.returnType))}${formatInlineFilters(symbol.returnType.filters)}`, "");
  } else if (type && type.returnType) {
    lines.push(`**Returns** ${codeSpan(formatTypeLabel(type.returnType))}${formatInlineFilters(type.returnType.filters)}`, "");
  }

  if (symbol.parameters && symbol.parameters.length > 0) {
    lines.push("**Parameters**");
    for (const parameter of symbol.parameters) {
      lines.push(`- ${codeSpan(parameter.name)}: ${codeSpan(formatTypeLabel(parameter.type))}`);
    }
    lines.push("");
  } else if (type && type.parameters && type.parameters.length > 0) {
    lines.push(`**Inputs** ${type.parameters.map(codeSpan).join(", ")}`, "");
  }

  if (type && type.parameterTypes && type.parameterTypes.length > 0) {
    lines.push("**Input filters**");
    type.parameterTypes.forEach((parameterType, index) => {
      const filters = parameterType.filters && parameterType.filters.length > 0
        ? parameterType.filters.map((filter) => `\`${filter}\``).join(", ")
        : "`IsObject`";
      const name = type.parameters && type.parameters[index] ? type.parameters[index] : `arg${index + 1}`;
      lines.push(`- ${codeSpan(name)}: ${filters}`);
    });
    lines.push("");
  }

  if (type && type.declarations && type.declarations.length > 0) {
    const declaration = type.declarations[0];
    lines.push(`**Declaration** \`${declaration.callee}\` · \`${declaration.file}:${declaration.line}\``, "");
  }

  return lines.join("\n");
}

function appendTypeDetails(lines, type) {
  if (!type) {
    return;
  }
  appendFilterLine(lines, type.filters, "**Filters**");
  if (type.element) {
    lines.push(`**Element** ${codeSpan(formatTypeLabel(type.element))}${formatInlineFilters(type.element.filters)}`);
  }
}

function appendFilterLine(lines, filters, label) {
  if (filters && filters.length > 0) {
    lines.push(`${label}: ${filters.map((filter) => `\`${filter}\``).join(", ")}`);
  }
}

function formatInlineFilters(filters) {
  return filters && filters.length > 0
    ? ` · ${filters.map((filter) => `\`${filter}\``).join(", ")}`
    : "";
}

function scopeLabel(scope) {
  if (scope === "documented global") {
    return "system";
  }
  if (scope === "declared global") {
    return "declared";
  }
  return scope;
}

function codeSpan(value) {
  return `\`${String(value).replace(/`/g, "\\`")}\``;
}

function formatTypeLabel(type) {
  if (!type) {
    return "unknown";
  }
  if (type.returnType) {
    const params = Array.isArray(type.parameters) ? type.parameters.join(", ") : "";
    return `function(${params}) -> ${formatTypeLabel(type.returnType)}`;
  }
  return type.label || "GAP object";
}

function createScope(kind, start, end, parent) {
  return {
    kind,
    start,
    end,
    parent,
    symbols: new Map()
  };
}

function innermostScopeAt(scopes, offset) {
  return scopes
    .filter((scope) => offset >= scope.start && offset <= scope.end)
    .sort((left, right) => (right.end - right.start) - (left.end - left.start))
    .at(-1) || scopes[0];
}

function lookupSymbol(scope, name) {
  let current = scope;
  while (current) {
    if (current.symbols.has(name)) {
      return current.symbols.get(name);
    }
    current = current.parent;
  }
  return undefined;
}

function findMatchingFunctionEnd(masked, bodyStart) {
  const regex = /\b(function|if|for|while|repeat|end)\b/g;
  regex.lastIndex = bodyStart;
  let depth = 1;
  let match;

  while ((match = regex.exec(masked)) !== null) {
    if (match[1] === "function" || match[1] === "if" || match[1] === "for" || match[1] === "while" || match[1] === "repeat") {
      depth += 1;
    } else if (match[1] === "end") {
      depth -= 1;
      if (depth === 0) {
        return match.index;
      }
    }
  }

  return -1;
}

function isInExcludedRange(offset, ranges) {
  return ranges.some(([start, end]) => offset >= start && offset <= end);
}

function leadingWhitespaceLength(text) {
  const match = /^\s*/.exec(text);
  return match ? match[0].length : 0;
}

function splitCommaList(text) {
  return splitTopLevel(text, ",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function splitTopLevel(text, delimiter) {
  return splitTopLevelWithSpans(text, delimiter).map((span) => span.text);
}

function splitTopLevelWithSpans(text, delimiter) {
  const parts = [];
  let current = "";
  let partStart = 0;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      current += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      current += char;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") {
      depth += 1;
    } else if (char === ")" || char === "]" || char === "}") {
      depth = Math.max(0, depth - 1);
    }

    if (char === delimiter && depth === 0) {
      parts.push({ text: current, start: partStart, end: index });
      current = "";
      partStart = index + 1;
    } else {
      current += char;
    }
  }

  if (current || text.endsWith(delimiter)) {
    parts.push({ text: current, start: partStart, end: text.length });
  }
  return parts;
}

function maskCommentsAndStrings(text) {
  const chars = text.split("");
  let inString = false;
  let escaped = false;

  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    if (inString) {
      chars[index] = " ";
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      chars[index] = " ";
      continue;
    }

    if (char === "#") {
      while (index < chars.length && chars[index] !== "\n") {
        chars[index] = " ";
        index += 1;
      }
    }
  }

  return chars.join("");
}

function computeLineStarts(text) {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") {
      starts.push(index + 1);
    }
  }
  return starts;
}

function offsetAt(lineStarts, line, character) {
  const lineStart = lineStarts[Math.max(0, Math.min(line, lineStarts.length - 1))] || 0;
  return lineStart + character;
}

function rangeFromOffset(lineStarts, offset) {
  let line = 0;
  for (let index = 0; index < lineStarts.length; index += 1) {
    if (lineStarts[index] <= offset) {
      line = index;
    } else {
      break;
    }
  }
  return {
    line,
    character: offset - lineStarts[line]
  };
}

function wordAt(text, offset) {
  if (offset < 0 || offset > text.length) {
    return undefined;
  }

  let start = offset;
  while (start > 0 && /[A-Za-z0-9_]/.test(text[start - 1])) {
    start -= 1;
  }

  let end = offset;
  while (end < text.length && /[A-Za-z0-9_]/.test(text[end])) {
    end += 1;
  }

  if (start === end) {
    return undefined;
  }

  return {
    text: text.slice(start, end),
    start,
    end
  };
}

function sortedUnique(values) {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function markdownToPlainText(markdown) {
  return markdown
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .trim();
}

function escapeMarkdown(text) {
  return String(text).replace(/[\\`*_{}[\]()#+\-.!|>]/g, "\\$&");
}

module.exports = {
  GapAnalyzer,
  analyzeGapText,
  formatInferenceMarkdown,
  inferExpression,
  typeInfo
};
