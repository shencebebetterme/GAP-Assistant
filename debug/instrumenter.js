"use strict";

const { parseGapSource } = require("../server/parser");

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function instrumentGapSource(text, sourcePath, options = {}) {
  const lineStarts = computeLineStarts(text);
  const ast = parseGapSource(text);
  const probes = collectProbeMetadata(text, sourcePath, ast, lineStarts);
  const insertions = probes.map((probe) => ({
    offset: probe.offset,
    text: probeCall(probe, options)
  }));

  const instrumented = applyInsertions(text, insertions);
  return {
    ast,
    lineStarts,
    probes,
    prelude: gapDebugPrelude(options),
    instrumented: `${gapDebugPrelude(options)}\n${instrumented}\nQUIT;\n`
  };
}

function collectProbeMetadata(text, sourcePath, ast = parseGapSource(text), lineStarts = computeLineStarts(text)) {
  const probes = [];
  const scope = createInstrumentationScope("<main>", 0, []);
  walkStatements(ast.statements || [], scope, probes, sourcePath, lineStarts);
  return probes.map((probe, index) => ({
    ...probe,
    id: index + 1
  }));
}

function walkStatements(statements, scope, probes, sourcePath, lineStarts) {
  for (const statement of statements || []) {
    if (statement.type === "localDeclaration") {
      for (const name of statement.names || []) {
        addVisibleName(scope, name.name);
      }
      addProbe(statement, scope, probes, sourcePath, lineStarts, {
        offset: statement.end,
        lineOffset: statement.start
      });
      continue;
    }

    addProbe(statement, scope, probes, sourcePath, lineStarts);

    if (statement.type === "assignment") {
      addVisibleName(scope, statement.name);
      continue;
    }

    if (statement.type === "functionAssignment") {
      const bodyScope = createInstrumentationScope(statement.name, scope.depth + 1, [
        ...scope.visible,
        ...(statement.params || []).map((param) => param.name)
      ]);
      walkStatements(statement.body || [], bodyScope, probes, sourcePath, lineStarts);
      addVisibleName(scope, statement.name);
      continue;
    }

    if (statement.type === "ifStatement") {
      const branchScopes = [];
      for (const branch of statement.branches || []) {
        const branchScope = scope.clone();
        branchScopes.push(branchScope);
        walkStatements(branch.body || [], branchScope, probes, sourcePath, lineStarts);
      }
      if (statement.elseBody && statement.elseBody.length > 0) {
        const elseScope = scope.clone();
        branchScopes.push(elseScope);
        walkStatements(statement.elseBody || [], elseScope, probes, sourcePath, lineStarts);
      }
      mergeVisibleNames(scope, branchScopes);
      continue;
    }

    if (statement.type === "forStatement") {
      const loopScope = scope.clone();
      const variable = statement.variable && statement.variable.text;
      addVisibleName(loopScope, variable);
      walkStatements(statement.body || [], loopScope, probes, sourcePath, lineStarts);
      mergeVisibleNames(scope, [loopScope]);
      continue;
    }

    if (statement.type === "whileStatement" || statement.type === "repeatStatement") {
      const loopScope = scope.clone();
      walkStatements(statement.body || [], loopScope, probes, sourcePath, lineStarts);
      mergeVisibleNames(scope, [loopScope]);
    }
  }
}

function addProbe(statement, scope, probes, sourcePath, lineStarts, options = {}) {
  if (!statement || typeof statement.start !== "number") {
    return;
  }

  const position = positionFromOffset(lineStarts, options.lineOffset ?? statement.start);
  probes.push({
    offset: options.offset ?? statement.start,
    sourcePath,
    line: position.line + 1,
    column: position.character + 1,
    functionName: scope.functionName,
    depth: scope.depth,
    variables: sortedVisibleNames(scope.visible)
  });
}

function createInstrumentationScope(functionName, depth, names) {
  const scope = {
    functionName,
    depth,
    visible: new Set(),
    clone() {
      return createInstrumentationScope(this.functionName, this.depth, this.visible);
    }
  };

  for (const name of names || []) {
    addVisibleName(scope, name);
  }
  return scope;
}

function addVisibleName(scope, name) {
  if (IDENTIFIER_RE.test(String(name || ""))) {
    scope.visible.add(name);
  }
}

function mergeVisibleNames(targetScope, sourceScopes) {
  for (const sourceScope of sourceScopes || []) {
    for (const name of sourceScope.visible) {
      addVisibleName(targetScope, name);
    }
  }
}

function sortedVisibleNames(names) {
  return [...names].sort((left, right) => left.localeCompare(right));
}

function probeCall(probe, options = {}) {
  const variables = probe.variables || [];
  const names = `[${variables.map(gapString).join(", ")}]`;
  const captures = `[${variables.map(captureExpression).join(", ")}]`;
  return [
    "__GAPDEBUG_Probe(",
    String(probe.id),
    ", ",
    gapString(probe.sourcePath),
    ", ",
    String(probe.line),
    ", ",
    String(probe.column),
    ", ",
    gapString(probe.functionName || "<main>"),
    ", ",
    String(probe.depth || 0),
    ", ",
    names,
    ", ",
    captures,
    ");\n"
  ].join("");
}

function captureExpression(name) {
  return `__GAPDEBUG_Capture(IsBound(${name}), function() return ${name}; end)`;
}

function applyInsertions(text, insertions) {
  let result = text;
  const ordered = [...insertions].sort((left, right) => right.offset - left.offset);
  for (const insertion of ordered) {
    result = `${result.slice(0, insertion.offset)}${insertion.text}${result.slice(insertion.offset)}`;
  }
  return result;
}

function gapDebugPrelude(options = {}) {
  const maxValueLength = Number.isInteger(options.maxValueLength) ? options.maxValueLength : 4000;
  return `
__GAPDEBUG_MaxValueLength := ${maxValueLength};;

__GAPDEBUG_Escape := function(text)
  local out, ch;
  out := "";
  for ch in String(text) do
    if ch = '\\\\' then
      Append(out, "\\\\\\\\");
    elif ch = '\\n' then
      Append(out, "\\\\n");
    elif ch = '\\r' then
      Append(out, "\\\\r");
    elif ch = '\\t' then
      Append(out, "\\\\t");
    elif ch = '"' then
      Append(out, "\\\\\\"");
    else
      Add(out, ch);
    fi;
  od;
  return out;
end;;

__GAPDEBUG_Capture := function(bound, thunk)
  local value, text;
  if not bound then
    return rec(bound := false, text := "<unbound>");
  fi;
  value := thunk();
  text := String(value);
  if Length(text) > __GAPDEBUG_MaxValueLength then
    text := Concatenation(text{[1 .. __GAPDEBUG_MaxValueLength]}, "...");
  fi;
  return rec(bound := true, text := text);
end;;

__GAPDEBUG_Probe := function(id, file, line, column, functionName, depth, names, values)
  local i, command;
  Print("__GAPDEBUG_HIT__\\t", id, "\\t", __GAPDEBUG_Escape(file), "\\t", line, "\\t", column, "\\t", __GAPDEBUG_Escape(functionName), "\\t", depth, "\\n");
  for i in [1 .. Length(names)] do
    Print("__GAPDEBUG_VAR__\\t", __GAPDEBUG_Escape(names[i]), "\\t", values[i].bound, "\\t", __GAPDEBUG_Escape(values[i].text), "\\n");
  od;
  Print("__GAPDEBUG_END__\\n");
  command := ReadLine(InputTextUser());
  if command = fail then
    ErrorNoReturn("GAP debug input closed");
  fi;
  return;
end;;
`.trim();
}

function gapString(value) {
  return `"${String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "\\\"")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")}"`;
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

function positionFromOffset(lineStarts, offset) {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (lineStarts[mid] <= offset) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  const line = Math.max(0, high);
  return {
    line,
    character: offset - lineStarts[line]
  };
}

module.exports = {
  collectProbeMetadata,
  computeLineStarts,
  gapDebugPrelude,
  instrumentGapSource
};
