"use strict";

const assert = require("assert");
const Module = require("module");

const visibleNotebookEditors = [];
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
        build() {
          return {};
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
  assert.deepStrictEqual(extension.__test.groupEntries(undefined), [], "undocumented inferred symbols should not crash hover grouping");
  assert.deepStrictEqual(extension.__test.groupEntries([]), [], "empty documentation entries should group to an empty list");

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
