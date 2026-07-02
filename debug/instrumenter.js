"use strict";

const { parseGapSource } = require("../server/parser");

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function instrumentGapSource(text, sourcePath, options = {}) {
  const lineStarts = computeLineStarts(text);
  const ast = parseGapSource(text);
  const probeIdStart = Number.isInteger(options.probeIdStart) && options.probeIdStart > 0 ? options.probeIdStart : 1;
  const probes = collectProbeMetadata(text, sourcePath, ast, lineStarts)
    .map((probe, index) => ({
      ...probe,
      id: probeIdStart + index
    }));
  const runtimePrelude = normalizeRuntimePrelude(options.runtimePrelude);
  const insertions = probes.map((probe) => ({
    offset: probe.offset,
    text: probeCall(probe, options),
    probe
  }));

  const prelude = options.includePrelude === false ? "" : gapDebugPrelude(options);
  const instrumented = applyInsertions(text, insertions);
  const quitOnExit = options.quitOnExit !== false;
  return {
    ast,
    lineStarts,
    probes,
    prelude,
    lineMap: buildInstrumentedLineMap(text, sourcePath, lineStarts, prelude, insertions, runtimePrelude, {
      quitOnExit
    }),
    instrumented: instrumentedSourceText(prelude, runtimePrelude, instrumented, quitOnExit)
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
        addVisibleName(scope, name.name, "local");
      }
      addProbe(statement, scope, probes, sourcePath, lineStarts, {
        offset: statement.end,
        lineOffset: statement.start
      });
      continue;
    }

    addProbe(statement, scope, probes, sourcePath, lineStarts);

    if (statement.type === "assignment") {
      addAssignedName(scope, statement.name);
      continue;
    }

    if (statement.type === "functionAssignment") {
      const bodyScope = createInstrumentationScope(statement.name, scope.depth + 1, scope.visible);
      for (const param of statement.params || []) {
        addVisibleName(bodyScope, param.name, "local");
      }
      walkStatements(statement.body || [], bodyScope, probes, sourcePath, lineStarts);
      addAssignedName(scope, statement.name);
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
      addVisibleName(loopScope, variable, "local");
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
    variables: sortedVisibleVariables(scope.visible)
  });
}

function createInstrumentationScope(functionName, depth, variables) {
  const scope = {
    functionName,
    depth,
    visible: new Map(),
    clone() {
      return createInstrumentationScope(this.functionName, this.depth, this.visible);
    }
  };

  if (variables instanceof Map) {
    for (const [name, kind] of variables) {
      addVisibleName(scope, name, kind);
    }
  } else {
    for (const entry of variables || []) {
      if (typeof entry === "string") {
        addVisibleName(scope, entry, depth === 0 ? "global" : "local");
      } else if (entry && entry.name) {
        addVisibleName(scope, entry.name, entry.scope || (depth === 0 ? "global" : "local"));
      }
    }
  }
  return scope;
}

function addVisibleName(scope, name, kind) {
  if (IDENTIFIER_RE.test(String(name || ""))) {
    scope.visible.set(name, kind === "global" ? "global" : "local");
  }
}

function addAssignedName(scope, name) {
  if (!IDENTIFIER_RE.test(String(name || ""))) {
    return;
  }
  const existing = scope.visible.get(name);
  addVisibleName(scope, name, existing || (scope.depth === 0 ? "global" : "local"));
}

function mergeVisibleNames(targetScope, sourceScopes) {
  for (const sourceScope of sourceScopes || []) {
    for (const [name, kind] of sourceScope.visible) {
      addVisibleName(targetScope, name, kind);
    }
  }
}

function sortedVisibleVariables(variables) {
  return [...variables.entries()]
    .map(([name, scope]) => ({ name, scope }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function probeCall(probe, options = {}) {
  const variables = probe.variables || [];
  const names = `[${variables.map((variable) => gapString(variable.name)).join(", ")}]`;
  const captures = `[${variables.map((variable) => captureExpression(variable.name)).join(", ")}]`;
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

function buildInstrumentedLineMap(text, sourcePath, lineStarts, prelude, insertions, runtimePrelude = "", options = {}) {
  const lineMap = [];
  let generatedLine = 1;

  const markLine = (origin) => {
    if (origin && !lineMap[generatedLine]) {
      lineMap[generatedLine] = origin;
    }
  };

  const appendText = (chunk, originAtIndex) => {
    for (let index = 0; index < chunk.length; index += 1) {
      markLine(originAtIndex ? originAtIndex(index) : undefined);
      if (chunk[index] === "\n") {
        generatedLine += 1;
      }
    }
  };

  const appendOriginal = (start, end) => {
    appendText(text.slice(start, end), (index) => {
      const position = positionFromOffset(lineStarts, start + index);
      return {
        sourcePath,
        line: position.line + 1,
        column: position.character + 1
      };
    });
  };

  if (prelude) {
    appendText(prelude);
    appendText("\n");
  }
  if (runtimePrelude) {
    appendText(runtimePrelude);
    appendText("\n");
  }

  let offset = 0;
  for (const insertion of [...insertions].sort((left, right) => left.offset - right.offset)) {
    appendOriginal(offset, insertion.offset);
    appendText(insertion.text, () => ({
      sourcePath: insertion.probe.sourcePath,
      line: insertion.probe.line,
      column: insertion.probe.column
    }));
    offset = insertion.offset;
  }

  appendOriginal(offset, text.length);
  appendText(options.quitOnExit === false ? "\n" : "\nQUIT;\n");

  return lineMap;
}

function instrumentedSourceText(prelude, runtimePrelude, source, quitOnExit) {
  const chunks = [];
  if (prelude) {
    chunks.push(prelude);
  }
  if (runtimePrelude) {
    chunks.push(runtimePrelude);
  }
  chunks.push(source);
  const suffix = quitOnExit ? "QUIT;\n" : "";
  return `${chunks.join("\n")}\n${suffix}`;
}

function normalizeRuntimePrelude(value) {
  const text = typeof value === "string" ? value.trimEnd() : "";
  return text;
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
  return rec(bound := true, text := text, value := value);
end;;

__GAPDEBUG_Text := function(value)
  local text;
  text := String(value);
  if Length(text) > __GAPDEBUG_MaxValueLength then
    text := Concatenation(text{[1 .. __GAPDEBUG_MaxValueLength]}, "...");
  fi;
  return text;
end;;

__GAPDEBUG_ViewText := function(value)
  local text;
  text := ViewString(value);
  if Length(text) > __GAPDEBUG_MaxValueLength then
    text := Concatenation(text{[1 .. __GAPDEBUG_MaxValueLength]}, "...");
  fi;
  return text;
end;;

__GAPDEBUG_CommandStartsWith := function(command, prefix)
  if Length(command) < Length(prefix) then
    return false;
  fi;
  return command{[1 .. Length(prefix)]} = prefix;
end;;

__GAPDEBUG_ObjectKind := function(value)
  if IsGroup(value) then
    return "group";
  elif IsPerm(value) then
    return "permutation";
  elif IsMatrix(value) then
    return "matrix";
  elif IsField(value) then
    return "field";
  elif IsVectorSpace(value) then
    return "vector-space";
  elif IsAlgebra(value) then
    return "algebra";
  elif IsRing(value) then
    return "ring";
  elif IsMonoid(value) then
    return "monoid";
  elif IsSemigroup(value) then
    return "semigroup";
  elif IsRecord(value) then
    return "record";
  elif IsString(value) then
    return "string";
  elif IsList(value) then
    return "list";
  elif IsFFE(value) then
    return "field-element";
  elif IsInt(value) then
    return "integer";
  elif IsRat(value) then
    return "rational";
  elif IsCyclotomic(value) then
    return "cyclotomic";
  elif IsBool(value) then
    return "boolean";
  elif IsFunction(value) then
    return "function";
  fi;
  return "object";
end;;

__GAPDEBUG_ObjectLabel := function(kind)
  if kind = "group" then
    return "Group";
  elif kind = "permutation" then
    return "Permutation";
  elif kind = "matrix" then
    return "Matrix";
  elif kind = "field" then
    return "Field";
  elif kind = "vector-space" then
    return "Vector space";
  elif kind = "algebra" then
    return "Algebra";
  elif kind = "ring" then
    return "Ring";
  elif kind = "monoid" then
    return "Monoid";
  elif kind = "semigroup" then
    return "Semigroup";
  elif kind = "record" then
    return "Record";
  elif kind = "list" then
    return "List";
  elif kind = "string" then
    return "String";
  elif kind = "field-element" then
    return "Field element";
  elif kind = "cyclotomic" then
    return "Cyclotomic";
  elif kind = "rational" then
    return "Rational";
  elif kind = "integer" then
    return "Integer";
  elif kind = "boolean" then
    return "Boolean";
  elif kind = "function" then
    return "Function";
  fi;
  return "GAP object";
end;;

__GAPDEBUG_KnownType := function(value, kind)
  if kind = "group" then
    if IsPermGroup(value) then
      return "permutation group";
    elif IsPcGroup(value) then
      return "pc group";
    elif IsMatrixGroup(value) then
      return "matrix group";
    elif IsFpGroup(value) then
      return "finitely presented group";
    fi;
    return "group";
  elif kind = "permutation" then
    return "permutation";
  elif kind = "matrix" then
    return "matrix";
  elif kind = "field" then
    return "field";
  elif kind = "vector-space" then
    return "vector space";
  elif kind = "algebra" then
    return "algebra";
  elif kind = "ring" then
    return "ring";
  elif kind = "monoid" then
    return "monoid";
  elif kind = "semigroup" then
    return "semigroup";
  fi;
  return __GAPDEBUG_ObjectLabel(kind);
end;;

__GAPDEBUG_PrintSemanticObject := function(requestId, objectId, name, kind, label, view, knownType)
  Print("__GAPDEBUG_SEM_OBJECT__\\t", __GAPDEBUG_Escape(requestId), "\\t", __GAPDEBUG_Escape(objectId), "\\t", __GAPDEBUG_Escape(name), "\\t", __GAPDEBUG_Escape(kind), "\\t", __GAPDEBUG_Escape(label), "\\t", __GAPDEBUG_Escape(view), "\\t", __GAPDEBUG_Escape(knownType), "\\n");
end;;

__GAPDEBUG_PrintSemanticFact := function(requestId, objectId, label, value)
  Print("__GAPDEBUG_SEM_FACT__\\t", __GAPDEBUG_Escape(requestId), "\\t", __GAPDEBUG_Escape(objectId), "\\t", __GAPDEBUG_Escape(label), "\\t", __GAPDEBUG_Escape(__GAPDEBUG_Text(value)), "\\n");
end;;

__GAPDEBUG_PrintSemanticTextFact := function(requestId, objectId, label, value)
  Print("__GAPDEBUG_SEM_FACT__\\t", __GAPDEBUG_Escape(requestId), "\\t", __GAPDEBUG_Escape(objectId), "\\t", __GAPDEBUG_Escape(label), "\\t", __GAPDEBUG_Escape(value), "\\n");
end;;

__GAPDEBUG_PrintSemanticAction := function(requestId, objectId, actionId, label)
  Print("__GAPDEBUG_SEM_ACTION__\\t", __GAPDEBUG_Escape(requestId), "\\t", __GAPDEBUG_Escape(objectId), "\\t", __GAPDEBUG_Escape(actionId), "\\t", __GAPDEBUG_Escape(label), "\\n");
end;;

__GAPDEBUG_PrintSemanticDescription := function(requestId, name, value)
  local kind, label, objectId, dims, names;
  kind := __GAPDEBUG_ObjectKind(value);
  label := __GAPDEBUG_ObjectLabel(kind);
  objectId := name;
  __GAPDEBUG_PrintSemanticObject(requestId, objectId, name, kind, label, __GAPDEBUG_ViewText(value), __GAPDEBUG_KnownType(value, kind));

  if kind = "group" then
    __GAPDEBUG_PrintSemanticFact(requestId, objectId, "Order", Size(value));
    __GAPDEBUG_PrintSemanticFact(requestId, objectId, "Generators", Length(GeneratorsOfGroup(value)));
    if IsPermGroup(value) then
      __GAPDEBUG_PrintSemanticFact(requestId, objectId, "Moved points", MovedPoints(value));
      __GAPDEBUG_PrintSemanticFact(requestId, objectId, "Largest moved point", LargestMovedPoint(value));
    fi;
    __GAPDEBUG_PrintSemanticAction(requestId, objectId, "generators", "Show generators");
    __GAPDEBUG_PrintSemanticAction(requestId, objectId, "conjugacy-classes", "Conjugacy classes");
    __GAPDEBUG_PrintSemanticAction(requestId, objectId, "character-table", "Character table");
    __GAPDEBUG_PrintSemanticAction(requestId, objectId, "subgroup-lattice", "Subgroup lattice");
    __GAPDEBUG_PrintSemanticAction(requestId, objectId, "elements", "Elements");
  elif kind = "permutation" then
    __GAPDEBUG_PrintSemanticFact(requestId, objectId, "Order", Order(value));
    __GAPDEBUG_PrintSemanticFact(requestId, objectId, "Sign", SignPerm(value));
    __GAPDEBUG_PrintSemanticFact(requestId, objectId, "Moved points", MovedPoints(value));
    __GAPDEBUG_PrintSemanticFact(requestId, objectId, "Cycle structure", CycleStructurePerm(value));
    __GAPDEBUG_PrintSemanticAction(requestId, objectId, "inverse", "Inverse");
    __GAPDEBUG_PrintSemanticAction(requestId, objectId, "powers", "Small powers");
  elif kind = "matrix" then
    dims := DimensionsMat(value);
    __GAPDEBUG_PrintSemanticFact(requestId, objectId, "Dimensions", dims);
    __GAPDEBUG_PrintSemanticFact(requestId, objectId, "Rank", RankMat(value));
    if Length(dims) = 2 and dims[1] = dims[2] then
      __GAPDEBUG_PrintSemanticFact(requestId, objectId, "Determinant", DeterminantMat(value));
    fi;
    __GAPDEBUG_PrintSemanticAction(requestId, objectId, "transpose", "Transpose");
    __GAPDEBUG_PrintSemanticAction(requestId, objectId, "triangular-form", "Triangular form");
  elif kind = "field" then
    __GAPDEBUG_PrintSemanticFact(requestId, objectId, "Size", Size(value));
    __GAPDEBUG_PrintSemanticFact(requestId, objectId, "Characteristic", Characteristic(value));
    __GAPDEBUG_PrintSemanticAction(requestId, objectId, "zero-one", "Zero and one");
  elif kind = "vector-space" then
    __GAPDEBUG_PrintSemanticFact(requestId, objectId, "Dimension", Dimension(value));
    __GAPDEBUG_PrintSemanticFact(requestId, objectId, "Size", Size(value));
    __GAPDEBUG_PrintSemanticFact(requestId, objectId, "Field", LeftActingDomain(value));
    __GAPDEBUG_PrintSemanticAction(requestId, objectId, "basis", "Basis");
  elif kind = "algebra" then
    __GAPDEBUG_PrintSemanticFact(requestId, objectId, "Dimension", Dimension(value));
    __GAPDEBUG_PrintSemanticFact(requestId, objectId, "Size", Size(value));
    __GAPDEBUG_PrintSemanticAction(requestId, objectId, "basis", "Basis");
    __GAPDEBUG_PrintSemanticAction(requestId, objectId, "generators", "Show generators");
  elif kind = "ring" or kind = "monoid" or kind = "semigroup" then
    __GAPDEBUG_PrintSemanticFact(requestId, objectId, "Size", Size(value));
    __GAPDEBUG_PrintSemanticAction(requestId, objectId, "generators", "Show generators");
  elif kind = "record" then
    names := RecNames(value);
    __GAPDEBUG_PrintSemanticFact(requestId, objectId, "Fields", Length(names));
    __GAPDEBUG_PrintSemanticFact(requestId, objectId, "Field names", names);
    __GAPDEBUG_PrintSemanticAction(requestId, objectId, "record-fields", "Show fields");
  elif kind = "list" or kind = "string" then
    __GAPDEBUG_PrintSemanticFact(requestId, objectId, "Length", Length(value));
    __GAPDEBUG_PrintSemanticAction(requestId, objectId, "list-preview", "Preview entries");
  fi;
end;;

__GAPDEBUG_PrintSemanticObjects := function(requestId, names, values)
  local i;
  for i in [1 .. Length(names)] do
    if values[i].bound then
      __GAPDEBUG_PrintSemanticDescription(requestId, names[i], values[i].value);
    fi;
  od;
  Print("__GAPDEBUG_SEM_END__\\t", __GAPDEBUG_Escape(requestId), "\\n");
end;;

__GAPDEBUG_FindCapturedValue := function(name, names, values)
  local i;
  for i in [1 .. Length(names)] do
    if names[i] = name and values[i].bound then
      return values[i].value;
    fi;
  od;
  return fail;
end;;

__GAPDEBUG_PrintSemanticObjectByName := function(requestId, objectId, names, values)
  local value;
  value := __GAPDEBUG_FindCapturedValue(objectId, names, values);
  if value <> fail then
    __GAPDEBUG_PrintSemanticDescription(requestId, objectId, value);
  fi;
  Print("__GAPDEBUG_SEM_END__\\t", __GAPDEBUG_Escape(requestId), "\\n");
end;;

__GAPDEBUG_ListPreview := function(value)
  local count;
  count := Minimum(Length(value), 20);
  if count = 0 then
    return [];
  fi;
  return value{[1 .. count]};
end;;

__GAPDEBUG_GroupConjugacyClassSummary := function(value)
  return List(ConjugacyClasses(value), class -> rec(size := Size(class), representative := Representative(class)));
end;;

__GAPDEBUG_SubgroupClassSummary := function(value)
  return List(ConjugacyClassesSubgroups(value), class -> rec(size := Size(class), representative := Representative(class)));
end;;

__GAPDEBUG_CharacterTableSummary := function(value)
  local table;
  table := CharacterTable(value);
  return rec(classes := SizesConjugacyClasses(table), irreducibles := Irr(table));
end;;

__GAPDEBUG_RecordFieldSummary := function(value)
  local names;
  names := RecNames(value);
  return List(names, name -> rec(name := name, value := value.(name)));
end;;

__GAPDEBUG_ActionResult := function(value, action)
  if action = "generators" then
    if IsGroup(value) then
      return GeneratorsOfGroup(value);
    elif IsAlgebra(value) then
      return GeneratorsOfAlgebra(value);
    elif IsRing(value) then
      return GeneratorsOfRing(value);
    elif IsMonoid(value) then
      return GeneratorsOfMonoid(value);
    elif IsSemigroup(value) then
      return GeneratorsOfSemigroup(value);
    fi;
    return GeneratorsOfMagma(value);
  elif action = "conjugacy-classes" then
    return __GAPDEBUG_GroupConjugacyClassSummary(value);
  elif action = "character-table" then
    return __GAPDEBUG_CharacterTableSummary(value);
  elif action = "subgroup-lattice" then
    return __GAPDEBUG_SubgroupClassSummary(value);
  elif action = "elements" then
    return Elements(value);
  elif action = "inverse" then
    return value ^ -1;
  elif action = "powers" then
    return List([0 .. Minimum(Order(value), 12)], i -> value ^ i);
  elif action = "transpose" then
    return TransposedMat(value);
  elif action = "triangular-form" then
    return TriangulizedMat(value);
  elif action = "zero-one" then
    return rec(zero := Zero(value), one := One(value));
  elif action = "basis" then
    return Basis(value);
  elif action = "record-fields" then
    return __GAPDEBUG_RecordFieldSummary(value);
  elif action = "list-preview" then
    return __GAPDEBUG_ListPreview(value);
  fi;
  return fail;
end;;

__GAPDEBUG_PrintActionResponse := function(requestId, objectId, action, names, values)
  local value, result;
  value := __GAPDEBUG_FindCapturedValue(objectId, names, values);
  Print("__GAPDEBUG_ACTION_BEGIN__\\t", __GAPDEBUG_Escape(requestId), "\\t", __GAPDEBUG_Escape(objectId), "\\t", __GAPDEBUG_Escape(action), "\\n");
  if value = fail then
    Print("__GAPDEBUG_ACTION_ERROR__\\t", __GAPDEBUG_Escape(requestId), "\\tCaptured GAP object is no longer available.\\n");
  else
    result := __GAPDEBUG_ActionResult(value, action);
    if result = fail then
      Print("__GAPDEBUG_ACTION_ERROR__\\t", __GAPDEBUG_Escape(requestId), "\\tUnsupported semantic action.\\n");
    else
      Print("__GAPDEBUG_ACTION_RESULT__\\t", __GAPDEBUG_Escape(requestId), "\\t", __GAPDEBUG_Escape(__GAPDEBUG_Text(result)), "\\n");
    fi;
  fi;
  Print("__GAPDEBUG_ACTION_END__\\t", __GAPDEBUG_Escape(requestId), "\\n");
end;;

__GAPDEBUG_Probe := function(id, file, line, column, functionName, depth, names, values)
  local i, command, parts;
  Print("__GAPDEBUG_HIT__\\t", id, "\\t", __GAPDEBUG_Escape(file), "\\t", line, "\\t", column, "\\t", __GAPDEBUG_Escape(functionName), "\\t", depth, "\\n");
  for i in [1 .. Length(names)] do
    Print("__GAPDEBUG_VAR__\\t", __GAPDEBUG_Escape(names[i]), "\\t", values[i].bound, "\\t", __GAPDEBUG_Escape(values[i].text), "\\n");
  od;
  Print("__GAPDEBUG_END__\\n");
  while true do
    command := ReadLine(InputTextUser());
    if command = fail then
      ErrorNoReturn("GAP debug input closed");
    fi;
    if Length(command) > 0 and command[Length(command)] = '\\n' then
      command := command{[1 .. Length(command) - 1]};
    fi;
    if command = "__GAPDEBUG_CONTINUE__" then
      return;
    elif __GAPDEBUG_CommandStartsWith(command, "__GAPDEBUG_OBJECTS__\\t") then
      parts := SplitString(command, "\\t");
      if Length(parts) >= 2 then
        __GAPDEBUG_PrintSemanticObjects(parts[2], names, values);
      fi;
    elif __GAPDEBUG_CommandStartsWith(command, "__GAPDEBUG_OBJECT__\\t") then
      parts := SplitString(command, "\\t");
      if Length(parts) >= 3 then
        __GAPDEBUG_PrintSemanticObjectByName(parts[2], parts[3], names, values);
      fi;
    elif __GAPDEBUG_CommandStartsWith(command, "__GAPDEBUG_ACTION__\\t") then
      parts := SplitString(command, "\\t");
      if Length(parts) >= 4 then
        __GAPDEBUG_PrintActionResponse(parts[2], parts[3], parts[4], names, values);
      fi;
    fi;
  od;
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
