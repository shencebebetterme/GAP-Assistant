"use strict";

const assert = require("assert");
const Module = require("module");

const visibleNotebookEditors = [];
const semanticTokenBuilds = [];
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "vscode") {
    return {
      Disposable: {
        from: (...items) => ({ dispose: () => items.forEach((item) => item && item.dispose && item.dispose()) })
      },
      OverviewRulerLane: {
        Right: 4
      },
      SemanticTokensLegend: class SemanticTokensLegend {},
      SemanticTokensBuilder: class SemanticTokensBuilder {
        constructor() {
          this.tokens = [];
        }

        push(line, character, length, tokenType, tokenModifiers) {
          this.tokens.push({ line, character, length, tokenType, tokenModifiers });
        }

        build() {
          semanticTokenBuilds.push(this.tokens);
          return { tokens: this.tokens };
        }
      },
      MarkdownString: class MarkdownString {
        constructor() {
          this.value = "";
        }

        appendMarkdown(value) {
          this.value += value;
        }

        appendCodeblock(value) {
          this.value += value;
        }

        appendText(value) {
          this.value += value;
        }
      },
      Hover: class Hover {},
      NotebookCellKind: {
        Code: 2
      },
      Position: class Position {
        constructor(line, character) {
          this.line = line;
          this.character = character;
        }
      },
      Range: class Range {
        constructor(start, end) {
          this.start = start;
          this.end = end;
        }
      },
      Location: class Location {
        constructor(uri, range) {
          this.uri = uri;
          this.range = range;
        }
      },
      InlineValueVariableLookup: class InlineValueVariableLookup {
        constructor(range, variableName, caseSensitiveLookup) {
          this.range = range;
          this.variableName = variableName;
          this.caseSensitiveLookup = caseSensitiveLookup;
        }
      },
      DebugAdapterExecutable: class DebugAdapterExecutable {},
      Uri: {
        file: (value) => ({ fsPath: value }),
        parse: (value) => ({ toString: () => value })
      },
      commands: {
        registerCommand: () => ({ dispose() {} })
      },
      env: {
        openExternal: async () => undefined
      },
      debug: {
        breakpoints: [],
        registerDebugAdapterDescriptorFactory: () => ({ dispose() {} }),
        registerDebugConfigurationProvider: () => ({ dispose() {} }),
        onDidReceiveDebugSessionCustomEvent: () => ({ dispose() {} }),
        onDidStartDebugSession: () => ({ dispose() {} }),
        onDidTerminateDebugSession: () => ({ dispose() {} }),
        startDebugging: async () => true
      },
      languages: {
        registerDefinitionProvider: () => ({ dispose() {} }),
        registerDocumentSemanticTokensProvider: () => ({ dispose() {} }),
        registerHoverProvider: () => ({ dispose() {} }),
        registerInlineValuesProvider: () => ({ dispose() {} })
      },
      window: {
        createTextEditorDecorationType: () => ({ dispose() {} }),
        createOutputChannel: () => ({
          appendLine: () => undefined,
          dispose: () => undefined,
          show: () => undefined
        }),
        activeTextEditor: undefined,
        activeNotebookEditor: undefined,
        visibleNotebookEditors,
        visibleTextEditors: [],
        onDidChangeVisibleTextEditors: () => ({ dispose() {} }),
        showErrorMessage: () => undefined,
        showWarningMessage: () => undefined
      },
      workspace: {
        getConfiguration: () => ({
          get: (_key, defaultValue) => defaultValue
        })
      }
    };
  }

  return originalLoad.call(this, request, parent, isMain);
};

try {
  const extension = require("../src/extension");
  const semanticObjects = require("../src/semanticObjects");
  const { GapAnalyzer } = require("../server/analyzer");
  const { loadDeclarations, loadDocumentation } = require("../src/docs");
  const root = require("path").resolve(__dirname, "..");
  const docs = loadDocumentation(root);
  const declarations = loadDeclarations(root);
  assert.deepStrictEqual(extension.__test.groupEntries(undefined), [], "undocumented inferred symbols should not crash hover grouping");
  assert.deepStrictEqual(extension.__test.groupEntries([]), [], "empty documentation entries should group to an empty list");
  assert.strictEqual(
    semanticObjects.chooseSelectedObjectId("", [
      { objectId: "es", value: "[ 2, 3 ]" },
      { objectId: "G", value: "SymmetricGroup( [ 1 .. 3 ] )" },
      { objectId: "mySum", value: "function (a, b) ... end" }
    ]),
    "G",
    "GAP Objects should prefer group-like variables when auto-selecting an object card"
  );
  assert.strictEqual(
    semanticObjects.chooseSelectedObjectId("es", [
      { objectId: "es", value: "[ 2, 3 ]" },
      { objectId: "G", value: "SymmetricGroup( [ 1 .. 3 ] )" }
    ]),
    "es",
    "GAP Objects should keep the existing selected object when it is still available"
  );

  const config = {
    get(key, defaultValue) {
      if (key === "gapInstallationPath") {
        return "C:\\GAP";
      }
      return defaultValue;
    }
  };
  assert.strictEqual(
    extension.__test.resolveManualFilePath(
      config,
      { source: {} },
      { file: "chap2.html", manualId: "pkg:digraphs", manualRelativePath: "pkg/digraphs/doc" }
    ),
    "C:\\GAP\\pkg\\digraphs\\doc\\chap2.html",
    "package manual links should resolve under the configured GAP installation"
  );
  assert.strictEqual(
    extension.__test.onlineManualUrl({
      file: "chap2.html",
      manualId: "ref",
      manualRelativePath: "doc/ref",
      anchor: "X87C1BFB2826488B0"
    }),
    "https://docs.gap-system.org/doc/ref/chap2.html#X87C1BFB2826488B0",
    "reference manual hover links should open the online GAP documentation"
  );
  assert.strictEqual(
    extension.__test.onlineManualUrl({
      file: "chap9.html",
      manualId: "pkg:digraphs",
      manualRelativePath: "pkg/digraphs/doc",
      anchor: "X81FB5BE27903EC32"
    }),
    "https://docs.gap-system.org/pkg/digraphs/doc/chap9.html#X81FB5BE27903EC32",
    "GAPDoc package manual hover links should open online package documentation"
  );
  assert.strictEqual(
    extension.__test.onlineManualUrl({
      file: "CHAP001.htm",
      manualId: "pkg:ace",
      manualRelativePath: "pkg/ace/htm",
      anchor: "SSEC002.1"
    }),
    "https://docs.gap-system.org/pkg/ace/htm/CHAP001.htm#SSEC002.1",
    "legacy package manual hover links should open online package documentation"
  );

  const inlineDocument = testDocument(`G := SymmetricGroup(4);
person := rec(
  name := "Ada",
  age := 42
);
makeValues := function(n)
  local values;
  values := [1, 2, 3];
  return values;
end;
after := 1;
`);
  const inlineValues = extension.__test.gapInlineValuesForDocument(
    inlineDocument,
    { start: { line: 0, character: 0 }, end: { line: 10, character: 0 } },
    { stoppedLocation: { start: { line: 7, character: 2 }, end: { line: 7, character: 2 } } }
  );
  assert.deepStrictEqual(
    inlineValues.map((value) => `${value.variableName}@${value.range.start.line}`),
    ["G@0", "person@1", "n@5", "values@7"],
    "inline values should cover simple assignments and active function parameters up to the paused line"
  );

  const multilineInlineDocument = testDocument(`multiArg := function(
  left,
  right
)
  local sum;
  sum := left + right;
  return sum;
end;
after := 0;
`);
  const multilineInlineValues = extension.__test.gapInlineValuesForDocument(
    multilineInlineDocument,
    { start: { line: 0, character: 0 }, end: { line: 8, character: 0 } },
    { stoppedLocation: { start: { line: 5, character: 2 }, end: { line: 5, character: 2 } } }
  );
  assert.deepStrictEqual(
    multilineInlineValues.map((value) => `${value.variableName}@${value.range.start.line}`),
    ["left@1", "right@2", "sum@5"],
    "inline values should place active function parameters on their own lines and still skip function definitions"
  );

  const decorationOptions = extension.__test.runtimeErrorDecorationOptions();
  assert.strictEqual(decorationOptions.isWholeLine, true, "runtime error decoration should highlight the whole line");
  assert(String(decorationOptions.backgroundColor).includes("220, 38, 38"), "runtime error decoration should use a red highlight");
  assert.deepStrictEqual(
    extension.__test.normalizeRuntimeErrorEvent({
      sourcePath: "C:\\sample.g",
      line: 7,
      column: 3,
      message: "Error, bad value",
      details: "called from sample.g:7"
    }),
    {
      sourcePath: "C:\\sample.g",
      line: 7,
      column: 3,
      message: "Error, bad value",
      details: "called from sample.g:7"
    },
    "runtime error decoration events should normalize source location and details"
  );

  const notebookCell = {
    index: 2,
    kind: 2,
    notebook: {
      uri: {
        fsPath: "C:\\work\\demo.ipynb"
      }
    },
    document: {
      languageId: "gap",
      uri: {
        toString: () => "vscode-notebook-cell:/C%3A/work/demo.ipynb#W2sZmlsZQ%3D%3D"
      },
      getText: () => "x := 1;"
    }
  };
  assert.strictEqual(
    extension.__test.notebookCellSourceName(notebookCell),
    "demo.ipynb cell 3",
    "notebook cell debug source names should include notebook name and 1-based cell number"
  );
  assert.strictEqual(
    extension.__test.notebookCellFileBaseName(notebookCell),
    "demo.ipynb-cell-3",
    "notebook cell temp filenames should be filesystem-safe"
  );

  const firstCellDocument = testDocument("x := 41;\nhelper := function(n)\n  return n + x;\nend;\n", "gap-cell://demo/1");
  const secondCellDocument = testDocument("y := helper(1);\n", "gap-cell://demo/2");
  const notebook = {
    uri: {
      fsPath: "C:\\work\\demo.ipynb"
    },
    getCells: () => cells
  };
  const cells = [
    {
      index: 0,
      kind: 2,
      notebook,
      document: firstCellDocument
    },
    {
      index: 1,
      kind: 2,
      notebook,
      document: secondCellDocument
    }
  ];
  visibleNotebookEditors.push({ notebook });
  assert.strictEqual(
    extension.__test.previousGapNotebookCellsText(cells[1]),
    firstCellDocument.getText().trimEnd(),
    "notebook debug preludes should include previous GAP cells"
  );
  const analysisContext = extension.__test.documentAnalysisContext(secondCellDocument);
  assert(analysisContext.text.includes("helper := function"), "notebook analysis should include previous GAP cells");
  assert(analysisContext.text.endsWith(secondCellDocument.getText()), "notebook analysis should end with the active cell text");
  assert.strictEqual(analysisContext.lineOffset, 5, "notebook analysis should report the active cell line offset");
  assert(Array.isArray(analysisContext.sourceMap), "notebook analysis should include source mapping for definitions");

  const definitionProvider = new extension.__test.GapDefinitionProvider(new GapAnalyzer(docs, declarations));
  const sameFileDefinitionDocument = testDocument([
    "mySum := function(a, b)",
    "  return a + b;",
    "end;",
    "z := mySum(1, 2);",
    ""
  ].join("\n"));
  const sameFileDefinition = definitionProvider.provideDefinition(sameFileDefinitionDocument, { line: 3, character: 6 });
  assert.strictEqual(sameFileDefinition.uri, sameFileDefinitionDocument.uri, "same-file definitions should target the current document");
  assert.strictEqual(sameFileDefinition.range.start.line, 0, "function definition should point to its assignment line");
  assert.strictEqual(sameFileDefinition.range.start.character, 0, "function definition should point to the function name");

  const notebookDefinition = definitionProvider.provideDefinition(secondCellDocument, { line: 0, character: 6 });
  assert.strictEqual(notebookDefinition.uri, firstCellDocument.uri, "notebook definitions should jump to previous GAP cells");
  assert.strictEqual(notebookDefinition.range.start.line, 1, "notebook definition should preserve the previous cell line");
  assert.strictEqual(notebookDefinition.range.start.character, 0, "notebook definition should point to the function name");

  const importedDefinition = extension.__test.definitionLocationForHover({
    kind: "symbol",
    symbol: {
      name: "NeedsGroup",
      importedFrom: "file:///tmp/y.g",
      range: { line: 2, character: 4 }
    }
  }, { sourceMap: [], lineOffset: 0 }, sameFileDefinitionDocument);
  assert.strictEqual(importedDefinition.uri.toString(), "file:///tmp/y.g", "imported definitions should target their source URI");
  assert.strictEqual(importedDefinition.range.start.line, 2, "imported definitions should keep source line");
  assert.strictEqual(importedDefinition.range.start.character, 4, "imported definitions should keep source character");

  const semanticDocument = testDocument([
    "Digraph([1]);",
    "LoadPackage(\"digraphs\");",
    "Digraph([1]);",
    "SymmetricGroup(3);",
    "mySum := function(a, b)",
    "  return a + b;",
    "end;",
    "mySum(1, 2);",
    ""
  ].join("\n"));
  const semanticProvider = new extension.__test.GapSemanticTokensProvider(
    docs,
    declarations,
    new GapAnalyzer(docs, declarations)
  );
  const semanticTokens = semanticProvider.provideDocumentSemanticTokens(semanticDocument).tokens;
  assert(!semanticTokens.some((token) => token.line === 0 && token.character === 0), "unloaded package functions should not receive semantic tokens");
  assert(semanticTokens.some((token) => token.line === 2 && token.character === 0), "loaded package functions should receive semantic tokens after LoadPackage");
  assert(semanticTokens.some((token) => token.line === 3 && token.character === 0), "core GAP functions should still receive semantic tokens");
  assert(semanticTokens.some((token) => token.line === 7 && token.character === 0), "user-defined functions should receive semantic tokens");
} finally {
  Module._load = originalLoad;
}

function testDocument(text, uriText = "memory://test.g") {
  const lineStarts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") {
      lineStarts.push(index + 1);
    }
  }
  const lines = text.split(/\n/);
  return {
    languageId: "gap",
    uri: {
      toString: () => uriText
    },
    lineCount: lines.length,
    getText: () => text,
    lineAt: (line) => ({ text: lines[line] || "" }),
    offsetAt(position) {
      return lineStarts[position.line] + position.character;
    },
    positionAt(offset) {
      let line = 0;
      while (line + 1 < lineStarts.length && lineStarts[line + 1] <= offset) {
        line += 1;
      }
      return {
        line,
        character: offset - lineStarts[line]
      };
    }
  };
}

console.log("Extension helper tests passed.");
