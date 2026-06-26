"use strict";

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

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
  constructor(docs) {
    this.docs = docs || { entries: {}, names: [] };
    this.docsNameSet = new Set(this.docs.names || []);
  }

  analyze(text, uri = "") {
    return analyzeGapText(text, this.docs, uri);
  }

  hoverAt(text, line, character, uri = "") {
    const analysis = this.analyze(text, uri);
    return analysis.hoverAt(line, character);
  }
}

function analyzeGapText(text, docs, uri = "") {
  const lineStarts = computeLineStarts(text);
  const masked = maskCommentsAndStrings(text);
  const globalScope = createScope("global", 0, text.length, undefined);
  const functions = parseFunctionAssignments(text, masked, lineStarts, globalScope, docs);

  const functionRanges = functions.map((fn) => [fn.start, fn.end]);
  parseAssignments(text, masked, globalScope, docs, functionRanges);

  const document = {
    uri,
    text,
    lineStarts,
    scopes: [globalScope, ...functions.map((fn) => fn.scope)],
    functions,
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

      const documented = documentedCallableInfo(word.text, docs);
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

function parseFunctionAssignments(text, masked, lineStarts, globalScope, docs) {
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
    parseAssignments(text.slice(bodyStart, end), masked.slice(bodyStart, end), scope, docs, [], bodyStart);
    const returnType = inferReturnType(body, bodyStart, scope, docs);
    const fnType = functionType(params, returnType);

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
      parameters: paramSymbols,
      returnType
    });
  }

  return functions;
}

function parseAssignments(text, masked, scope, docs, excludedRanges = [], baseOffset = 0) {
  const regex = /\b([A-Za-z_][A-Za-z0-9_]*)\s*:=\s*([^;]+);/g;
  let match;

  while ((match = regex.exec(masked)) !== null) {
    const absoluteStart = baseOffset + match.index;
    if (isInExcludedRange(absoluteStart, excludedRanges)) {
      continue;
    }

    const name = match[1];
    const rawExpression = text.slice(match.index + match[0].indexOf(match[2]), match.index + match[0].length - 1).trim();
    if (/^function\s*\(/.test(rawExpression)) {
      continue;
    }

    const inferred = inferExpression(rawExpression, scope, docs);
    scope.symbols.set(name, {
      name,
      scope: scope.kind === "global" ? "global" : "local",
      range: rangeFromOffset(scope.lineStarts || computeLineStarts(text), match.index),
      type: inferred,
      source: rawExpression
    });
  }
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

function inferReturnType(body, bodyOffset, scope, docs) {
  const regex = /\breturn\s+([^;]+);/g;
  let returnType;
  let match;

  while ((match = regex.exec(maskCommentsAndStrings(body))) !== null) {
    const expression = body.slice(match.index + match[0].indexOf(match[1]), match.index + match[0].length - 1).trim();
    returnType = returnType ? mergeTypeInfo(returnType, inferExpression(expression, scope, docs)) : inferExpression(expression, scope, docs);
  }

  return returnType || typeInfo("no return value", ["IsObject"], { confidence: "inferred" });
}

function inferExpression(expression, scope, docs) {
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
    return typeInfo("integer", ["IsObject", "IsInt"], { confidence: "literal" });
  }
  if (/^-?\d+\s*\/\s*-?\d+$/.test(expr)) {
    return typeInfo("rational", ["IsObject", "IsRat"], { confidence: "literal" });
  }
  if (/^".*"$/.test(expr)) {
    return typeInfo("string", ["IsObject", "IsString", "IsList"], { confidence: "literal" });
  }
  if (/^\[.*\]$/.test(expr)) {
    const element = inferListElementType(expr, scope, docs);
    return typeInfo("list", ["IsObject", "IsCollection", "IsList"], { confidence: "literal", element });
  }
  if (/^rec\s*\(/.test(expr)) {
    return typeInfo("record", ["IsObject", "IsRecord"], { confidence: "literal" });
  }
  if (/^\([^)]*(?:,\s*\d+)+\)$/.test(expr)) {
    return typeInfo("permutation", ["IsObject", "IsPerm"], { confidence: "literal" });
  }
  const call = parseCallExpression(expr);
  if (call) {
    return inferCall(call.name, call.args, scope, docs);
  }

  if (/^function\s*\(/.test(expr) || /->/.test(expr)) {
    return typeInfo("function", ["IsObject", "IsFunction"], { confidence: "literal" });
  }

  const symbol = lookupSymbol(scope, expr);
  if (symbol) {
    return symbol.type;
  }

  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(expr)) {
    const documented = documentedCallableInfo(expr, docs);
    if (documented) {
      return documented.type;
    }
  }

  return typeInfo("unknown GAP object", ["IsObject"], { confidence: "unknown" });
}

function inferListElementType(expr, scope, docs) {
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

  return parts.map((part) => inferExpression(part, scope, docs)).reduce(mergeTypeInfo);
}

function inferCall(name, args, scope, docs) {
  const hardCoded = HARD_CODED_CALLS[name];
  if (hardCoded) {
    return addCallContext(hardCoded(), name, args, scope);
  }

  if (/^(Is|Has|Can)[A-Z]/.test(name)) {
    return typeInfo("boolean", ["IsObject", "IsBool"], {
      confidence: "name convention",
      source: `${name}(...)`
    });
  }

  const local = lookupSymbol(scope, name);
  if (local && local.returnType) {
    return local.returnType;
  }

  const documented = documentedCallableInfo(name, docs);
  if (documented) {
    return documented.returnType || documented.type;
  }

  return typeInfo("unknown return value", ["IsObject"], {
    confidence: "unknown",
    source: `${name}(...)`
  });
}

function addCallContext(type, name, args, scope) {
  const enriched = cloneType(type);
  enriched.source = `${name}(...)`;
  enriched.arguments = args.map((arg) => ({
    expression: arg,
    type: inferExpression(arg, scope, { entries: {}, names: [] })
  }));
  return enriched;
}

function documentedCallableInfo(name, docs) {
  const entries = docs && docs.entries && docs.entries[name];
  if (!entries || entries.length === 0) {
    return undefined;
  }

  const entry = entries[0];
  const returnType = inferReturnFromEntry(entry);
  return {
    name,
    scope: "documented global",
    type: functionType(signatureParameters(entry.signature), returnType, {
      label: `${entry.kind || "documented"} ${name}`,
      signatures: entries.map((candidate) => candidate.signature).filter(Boolean),
      documentation: returnSummary(entry)
    }),
    returnType,
    source: "GAP reference manual",
    documentation: returnSummary(entry)
  };
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

  return {
    name: match[1],
    args: splitTopLevel(match[2], ",")
  };
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
    documentation: options.documentation
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
    signatures: options.signatures || [],
    documentation: options.documentation,
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
      element: left.element || right.element
    }
  );
}

function formatInferenceMarkdown(hover) {
  if (!hover || !hover.symbol) {
    return "";
  }

  const symbol = hover.symbol;
  const type = symbol.returnType ? symbol.type : symbol.type;
  const lines = ["### Static GAP inference", ""];

  if (symbol.scope && symbol.scope !== "documented global") {
    lines.push(`_${escapeMarkdown(symbol.scope)} symbol_`, "");
  } else if (symbol.scope === "documented global") {
    lines.push("_documented global symbol_", "");
  }

  const displayName = symbol.name || hover.word.text;
  lines.push("```gap");
  lines.push(`${displayName} : ${formatTypeLabel(type)}`);
  lines.push("```", "");

  appendTypeDetails(lines, type);

  if (symbol.returnType) {
    lines.push(`Returns: \`${formatTypeLabel(symbol.returnType)}\``);
    appendFilterLine(lines, symbol.returnType.filters, "Return filters");
    lines.push("");
  } else if (type && type.returnType) {
    lines.push(`Returns: \`${formatTypeLabel(type.returnType)}\``);
    appendFilterLine(lines, type.returnType.filters, "Return filters");
    lines.push("");
  }

  if (symbol.parameters && symbol.parameters.length > 0) {
    lines.push("Parameters:");
    for (const parameter of symbol.parameters) {
      lines.push(`- \`${parameter.name}\`: ${formatTypeLabel(parameter.type)}`);
    }
    lines.push("");
  } else if (type && type.parameters && type.parameters.length > 0) {
    lines.push(`Inputs: ${type.parameters.map((param) => `\`${param}\``).join(", ")}`, "");
  }

  if (symbol.source) {
    lines.push(`Source: \`${truncate(symbol.source, 90)}\``, "");
  }
  if (type && type.documentation) {
    lines.push(`Documentation return hint: ${escapeMarkdown(truncate(type.documentation, 180))}`, "");
  }

  return lines.join("\n");
}

function appendTypeDetails(lines, type) {
  if (!type) {
    return;
  }
  appendFilterLine(lines, type.filters, "Filters");
  if (type.element) {
    lines.push(`Element: \`${formatTypeLabel(type.element)}\``);
    appendFilterLine(lines, type.element.filters, "Element filters");
  }
  if (type.confidence) {
    lines.push(`Confidence: ${escapeMarkdown(type.confidence)}`, "");
  }
}

function appendFilterLine(lines, filters, label) {
  if (filters && filters.length > 0) {
    lines.push(`${label}: ${filters.map((filter) => `\`${filter}\``).join(", ")}`);
  }
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

function splitCommaList(text) {
  return splitTopLevel(text, ",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function splitTopLevel(text, delimiter) {
  const parts = [];
  let current = "";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (const char of text) {
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
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  if (current || text.endsWith(delimiter)) {
    parts.push(current);
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

function truncate(text, length) {
  return text && text.length > length ? `${text.slice(0, length - 3)}...` : text;
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
