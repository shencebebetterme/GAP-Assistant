"use strict";

const assert = require("assert");
const Module = require("module");

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "vscode") {
    return {
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
        startDebugging: async () => true
      },
      languages: {
        registerDocumentSemanticTokensProvider: () => ({ dispose() {} }),
        registerHoverProvider: () => ({ dispose() {} }),
        registerInlineValuesProvider: () => ({ dispose() {} })
      },
      window: {
        createOutputChannel: () => ({
          appendLine: () => undefined,
          dispose: () => undefined,
          show: () => undefined
        }),
        activeTextEditor: undefined,
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
    ["G@0", "person@1", "values@7"],
    "inline values should cover simple assignments up to the paused line and skip function definitions and record fields"
  );
} finally {
  Module._load = originalLoad;
}

function testDocument(text) {
  const lineStarts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") {
      lineStarts.push(index + 1);
    }
  }
  const lines = text.split(/\n/);
  return {
    languageId: "gap",
    lineCount: lines.length,
    getText: () => text,
    lineAt: (line) => ({ text: lines[line] || "" }),
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
