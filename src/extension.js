"use strict";

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const vscode = require("vscode");
const { getEntries, isIdentifier, loadDeclarations, loadDocumentation } = require("./docs");
const { GapLanguageServerClient } = require("./lspClient");
const { GapAnalyzer, formatInferenceMarkdown } = require("../server/analyzer");
const { parseGapSource } = require("../server/parser");

const GAP_SELECTOR = { language: "gap" };
const IDENTIFIER_PATTERN = /[A-Za-z_][A-Za-z0-9_]*/;
const SEMANTIC_LEGEND = new vscode.SemanticTokensLegend(["function"], []);
let activeLanguageServerClient;
let activeDebugOutputChannel;

function activate(context) {
  let docs;
  let declarations;
  try {
    docs = loadDocumentation(context.extensionPath);
    declarations = loadDeclarations(context.extensionPath);
  } catch (error) {
    vscode.window.showWarningMessage(`GAP Reference Assistant could not load language data: ${error.message}`);
    return;
  }

  const analyzer = new GapAnalyzer(docs, declarations);
  const diagnosticCollection = vscode.languages.createDiagnosticCollection("gap");
  const debugOutputChannel = vscode.window.createOutputChannel("GAP Debugger");
  activeDebugOutputChannel = debugOutputChannel;
  const languageServerClient = new GapLanguageServerClient(path.join(context.extensionPath, "server", "lsp-server.js"), {
    cwd: context.extensionPath,
    timeoutMs: 1000
  });
  activeLanguageServerClient = languageServerClient;
  languageServerClient.ensureStarted().catch(() => {});

  context.subscriptions.push(
    diagnosticCollection,
    debugOutputChannel,
    { dispose: () => languageServerClient.dispose() },
    vscode.debug.registerDebugAdapterDescriptorFactory(
      "gap",
      new GapDebugAdapterDescriptorFactory(context.extensionPath, debugOutputChannel)
    ),
    vscode.debug.registerDebugConfigurationProvider("gap", new GapDebugConfigurationProvider()),
    vscode.languages.registerHoverProvider(GAP_SELECTOR, new GapHoverProvider(docs, analyzer, languageServerClient)),
    registerInlineValuesProvider(),
    vscode.languages.registerDocumentSemanticTokensProvider(
      GAP_SELECTOR,
      new GapSemanticTokensProvider(docs),
      SEMANTIC_LEGEND
    ),
    vscode.workspace.onDidOpenTextDocument((document) => updateGapDiagnostics(document, analyzer, diagnosticCollection)),
    vscode.workspace.onDidChangeTextDocument((event) => updateGapDiagnostics(event.document, analyzer, diagnosticCollection)),
    vscode.workspace.onDidCloseTextDocument((document) => diagnosticCollection.delete(document.uri)),
    vscode.commands.registerCommand("gapReference.openLocalManual", (target) => openLocalManual(context, docs, target)),
    vscode.commands.registerCommand("gapReference.debugCurrentFile", (resource) => debugCurrentFile(resource, debugOutputChannel))
  );

  for (const document of vscode.workspace.textDocuments || []) {
    updateGapDiagnostics(document, analyzer, diagnosticCollection);
  }
}

function deactivate() {
  return activeLanguageServerClient ? activeLanguageServerClient.dispose() : undefined;
}

function updateGapDiagnostics(document, analyzer, collection) {
  if (!document || document.languageId !== "gap") {
    return;
  }

  const analysis = analyzer.analyze(document.getText(), document.uri.toString());
  const diagnostics = analysis.diagnostics.map((diagnostic) => {
    const range = new vscode.Range(
      new vscode.Position(diagnostic.range.start.line, diagnostic.range.start.character),
      new vscode.Position(diagnostic.range.end.line, diagnostic.range.end.character)
    );
    const item = new vscode.Diagnostic(range, diagnostic.message, diagnosticSeverity(diagnostic.severity));
    item.source = diagnostic.source;
    item.code = diagnostic.code;
    return item;
  });

  collection.set(document.uri, diagnostics);
}

function diagnosticSeverity(severity) {
  if (severity === 1) {
    return vscode.DiagnosticSeverity.Error;
  }
  if (severity === 2) {
    return vscode.DiagnosticSeverity.Warning;
  }
  if (severity === 3) {
    return vscode.DiagnosticSeverity.Information;
  }
  return vscode.DiagnosticSeverity.Hint;
}

function registerInlineValuesProvider() {
  if (typeof vscode.languages.registerInlineValuesProvider !== "function") {
    return { dispose() {} };
  }
  return vscode.languages.registerInlineValuesProvider(GAP_SELECTOR, new GapInlineValuesProvider());
}

class GapHoverProvider {
  constructor(docs, analyzer, languageServerClient) {
    this.docs = docs;
    this.analyzer = analyzer;
    this.languageServerClient = languageServerClient;
    this.analysisCache = new Map();
  }

  async provideHover(document, position) {
    const range = document.getWordRangeAtPosition(position, IDENTIFIER_PATTERN);
    if (!range) {
      return undefined;
    }

    const name = document.getText(range);
    const entries = getEntries(this.docs, name) || [];
    const inferenceMarkdown = await this.inferenceMarkdown(document, position);
    if (entries.length === 0 && !inferenceMarkdown) {
      return undefined;
    }

    const config = vscode.workspace.getConfiguration("gapReference");
    const maxEntries = config.get("hover.maxEntries", 4);
    const maxDescriptionLength = config.get("hover.maxDescriptionLength", 900);
    const wrapColumn = config.get("hover.wrapColumn", 86);
    const maxExamples = config.get("hover.maxExamples", 1);
    const maxExampleLines = config.get("hover.maxExampleLines", 14);
    const entryGroups = groupEntries(entries);
    const shownEntryGroups = entryGroups.slice(0, maxEntries);

    const markdown = new vscode.MarkdownString(undefined, true);
    markdown.supportHtml = true;
    markdown.isTrusted = {
      enabledCommands: ["gapReference.openLocalManual"]
    };

    if (inferenceMarkdown) {
      markdown.appendMarkdown(inferenceMarkdown);
      if (shownEntryGroups.length > 0) {
        markdown.appendMarkdown("\n\n---\n\n");
      }
    }

    shownEntryGroups.forEach((group, index) => {
      const title = [group.entry.section, group.entry.title || group.entry.name].filter(Boolean).join(" ");
      if (title) {
        markdown.appendMarkdown(`### ${escapeMarkdown(title)}\n\n`);
      }

      const signatures = group.signatures.length > 0 ? group.signatures : [group.entry.name];
      markdown.appendCodeblock(signatures.map((signature) => wrapSignature(signature, wrapColumn)).join("\n"), "gap");

      const meta = [
        group.entry.kind,
        group.entry.packageName ? `${group.entry.packageName} package` : undefined,
        group.entry.section ? `section ${group.entry.section}` : undefined
      ]
        .filter(Boolean)
        .join(" - ");
      if (meta) {
        markdown.appendMarkdown(`_${escapeMarkdown(meta)}_\n\n`);
      }

      if (Array.isArray(group.entry.blocks) && group.entry.blocks.length > 0) {
        appendBlocks(markdown, group.entry.blocks, {
          fallbackText: group.entry.description,
          maxDescriptionLength,
          maxExamples,
          maxExampleLines,
          wrapColumn
        });
      } else if (group.entry.description) {
        appendWrappedText(markdown, truncate(group.entry.description, maxDescriptionLength), wrapColumn);
      }

      markdown.appendMarkdown(`[$(book) Open full local GAP documentation](${manualCommandUri(group.entry)})`);

      if (index < shownEntryGroups.length - 1) {
        markdown.appendMarkdown("\n\n---\n\n");
      }
    });

    if (entryGroups.length > shownEntryGroups.length) {
      markdown.appendMarkdown("\n\n");
      markdown.appendText(`${entryGroups.length - shownEntryGroups.length} more reference entries omitted.`);
    }

    return new vscode.Hover(markdown, range);
  }

  async inferenceMarkdown(document, position) {
    const fallbackHover = this.inferenceHover(document, position);
    const fallbackMarkdown = fallbackHover ? formatInferenceMarkdown(fallbackHover) : "";

    if (fallbackHover && fallbackHover.kind === "symbol") {
      return fallbackMarkdown;
    }

    try {
      const hover = await this.languageServerClient.hover(document, position);
      return (hover && hover.contents && hover.contents.value) || fallbackMarkdown;
    } catch (_) {
      return fallbackMarkdown;
    }
  }

  inferenceHover(document, position) {
    const key = `${document.uri.toString()}@${document.version}`;
    let analysis = this.analysisCache.get(key);
    if (!analysis) {
      analysis = this.analyzer.analyze(document.getText(), document.uri.toString());
      this.analysisCache.clear();
      this.analysisCache.set(key, analysis);
    }
    return analysis.hoverAt(position.line, position.character);
  }
}

class GapInlineValuesProvider {
  provideInlineValues(document, viewPort, context) {
    return gapInlineValuesForDocument(document, viewPort, context);
  }
}

function gapInlineValuesForDocument(document, viewPort, context) {
  if (!document || document.languageId !== "gap" || typeof vscode.InlineValueVariableLookup !== "function") {
    return [];
  }

  const values = [];
  const seen = new Set();
  const firstLine = Math.max(0, viewPort && viewPort.start ? viewPort.start.line : 0);
  const lastLine = inlineValuesLastLine(document, viewPort, context);

  for (const target of assignmentTargetsInDocument(document, firstLine, lastLine)) {
    const key = `${target.line}:${target.name}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const range = new vscode.Range(
      new vscode.Position(target.line, target.startCharacter),
      new vscode.Position(target.line, target.endCharacter)
    );
    values.push(new vscode.InlineValueVariableLookup(range, target.name, true));
  }

  return values;
}

function inlineValuesLastLine(document, viewPort, context) {
  const documentLastLine = Math.max(0, document.lineCount - 1);
  const viewportLastLine = viewPort && viewPort.end ? Math.min(documentLastLine, viewPort.end.line) : documentLastLine;
  const stoppedLine = context && context.stoppedLocation && context.stoppedLocation.start
    ? context.stoppedLocation.start.line
    : undefined;
  return Number.isInteger(stoppedLine) ? Math.min(viewportLastLine, stoppedLine) : viewportLastLine;
}

function assignmentTargetsInDocument(document, firstLine, lastLine) {
  const ast = parseGapSource(document.getText());
  const targets = [];
  collectAssignmentTargets(ast.statements || [], targets);
  return targets
    .map((target) => {
      const start = document.positionAt(target.nameStart);
      const end = document.positionAt(target.nameEnd);
      return {
        name: target.name,
        line: start.line,
        startCharacter: start.character,
        endCharacter: end.character
      };
    })
    .filter((target) => target.line >= firstLine && target.line <= lastLine);
}

function collectAssignmentTargets(statements, targets) {
  for (const statement of statements || []) {
    if (statement.type === "assignment" && statement.name) {
      targets.push({
        name: statement.name,
        nameStart: statement.nameStart,
        nameEnd: statement.nameEnd
      });
    }

    if (statement.type === "functionAssignment") {
      collectAssignmentTargets(statement.body, targets);
    } else if (statement.type === "ifStatement") {
      for (const branch of statement.branches || []) {
        collectAssignmentTargets(branch.body, targets);
      }
      collectAssignmentTargets(statement.elseBody, targets);
    } else if (statement.type === "forStatement" || statement.type === "whileStatement" || statement.type === "repeatStatement") {
      collectAssignmentTargets(statement.body, targets);
    }
  }
}

class GapSemanticTokensProvider {
  constructor(docs) {
    this.names = new Set(docs.names.filter(isIdentifier));
  }

  provideDocumentSemanticTokens(document) {
    const config = vscode.workspace.getConfiguration("gapReference");
    const enabled = config.get("semanticHighlighting.enabled", true);
    const builder = new vscode.SemanticTokensBuilder(SEMANTIC_LEGEND);

    if (!enabled) {
      return builder.build();
    }

    for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber += 1) {
      const line = document.lineAt(lineNumber).text;
      const searchable = maskNonCode(line);
      const regex = /\b[A-Za-z_][A-Za-z0-9_]*\b/g;
      let match;

      while ((match = regex.exec(searchable)) !== null) {
        const name = match[0];
        if (this.names.has(name)) {
          builder.push(lineNumber, match.index, name.length, 0, 0);
        }
      }
    }

    return builder.build();
  }
}

function maskNonCode(line) {
  const chars = line.split("");
  let inString = false;
  let inChar = false;
  let escaped = false;

  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];

    if (!inString && !inChar && char === "#") {
      for (let rest = index; rest < chars.length; rest += 1) {
        chars[rest] = " ";
      }
      break;
    }

    if (inString || inChar) {
      chars[index] = " ";

      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === "\\") {
        escaped = true;
        continue;
      }

      if (inString && char === "\"") {
        inString = false;
      } else if (inChar && char === "'") {
        inChar = false;
      }

      continue;
    }

    if (char === "\"") {
      chars[index] = " ";
      inString = true;
    } else if (char === "'") {
      chars[index] = " ";
      inChar = true;
    }
  }

  return chars.join("");
}

function manualCommandUri(entry) {
  const payload = encodeURIComponent(
    JSON.stringify([
      {
        anchor: entry.anchor,
        file: entry.file,
        manualId: entry.manualId,
        manualRelativePath: entry.manualRelativePath,
        name: entry.name
      }
    ])
  );
  return `command:gapReference.openLocalManual?${payload}`;
}

function groupEntries(entries = []) {
  const groupsByKey = new Map();

  for (const entry of entries) {
    const key = [
      entry.anchor,
      entry.file,
      entry.manualId,
      entry.manualRelativePath,
      entry.kind,
      entry.section,
      entry.description,
      JSON.stringify(entry.blocks || [])
    ].join("\u0000");
    const signature = entry.signature || entry.name;

    if (!groupsByKey.has(key)) {
      groupsByKey.set(key, {
        entry,
        signatures: []
      });
    }

    const group = groupsByKey.get(key);
    if (!group.signatures.includes(signature)) {
      group.signatures.push(signature);
    }
  }

  return Array.from(groupsByKey.values());
}

function appendBlocks(markdown, blocks, options) {
  let exampleCount = 0;
  let proseLength = 0;
  let renderedAny = false;

  for (const block of blocks) {
    if (block.type === "paragraph" && block.markdown) {
      if (proseLength >= options.maxDescriptionLength) {
        continue;
      }

      const remaining = options.maxDescriptionLength - proseLength;
      const text = truncate(block.markdown, remaining);
      appendWrappedMarkdown(markdown, text, options.wrapColumn);
      proseLength += text.length;
      renderedAny = true;
    } else if (block.type === "example" && block.code && exampleCount < options.maxExamples) {
      markdown.appendMarkdown("**Example**\n\n");
      markdown.appendCodeblock(limitExampleLines(block.code, options.maxExampleLines), "gap");
      exampleCount += 1;
      renderedAny = true;
    }
  }

  if (!renderedAny && options.fallbackText) {
    appendWrappedText(markdown, truncate(options.fallbackText, options.maxDescriptionLength), options.wrapColumn);
  }
}

function appendWrappedText(markdown, text, column) {
  const paragraphs = text.split(/\n{2,}/).map((paragraph) => paragraph.trim()).filter(Boolean);

  for (const paragraph of paragraphs) {
    const wrappedLines = wrapText(paragraph, column).map(escapeMarkdown);
    markdown.appendMarkdown(`${wrappedLines.join("  \n")}\n\n`);
  }
}

function appendWrappedMarkdown(markdown, text, column) {
  const paragraphs = text.split(/\n{2,}/).map((paragraph) => paragraph.trim()).filter(Boolean);

  for (const paragraph of paragraphs) {
    const wrappedLines = wrapText(paragraph, column);
    markdown.appendMarkdown(`${wrappedLines.join("  \n")}\n\n`);
  }
}

function limitExampleLines(code, maxLines) {
  const lines = code.split(/\r?\n/);
  if (lines.length <= maxLines) {
    return code;
  }

  return [...lines.slice(0, maxLines), `... ${lines.length - maxLines} more lines`].join("\n");
}

function wrapSignature(signature, column) {
  if (!signature || signature.length <= column) {
    return signature;
  }

  const openParen = signature.indexOf("(");
  const closeParen = signature.lastIndexOf(")");
  if (openParen < 0 || closeParen < openParen) {
    return wrapText(signature, column).join("\n");
  }

  const head = signature.slice(0, openParen + 1);
  const args = signature.slice(openParen + 1, closeParen);
  const tail = signature.slice(closeParen);
  const pieces = splitArguments(args);
  if (pieces.length <= 1) {
    return wrapText(signature, column).join("\n");
  }

  const indent = " ".repeat(head.length);
  const lines = [];
  let current = head;

  for (let index = 0; index < pieces.length; index += 1) {
    const suffix = index < pieces.length - 1 ? "," : tail;
    const part = `${pieces[index]}${suffix}`;
    if (current.length > head.length && current.length + part.length + 1 > column) {
      lines.push(current);
      current = `${indent}${part}`;
    } else {
      current = current.length === head.length ? `${current}${part}` : `${current} ${part}`;
    }
  }

  lines.push(current);
  return lines.join("\n");
}

function splitArguments(args) {
  return args.split(",").map((arg) => arg.trim()).filter(Boolean);
}

function wrapText(text, column) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";

  for (const word of words) {
    if (!current) {
      current = word;
      continue;
    }

    if (current.length + word.length + 1 <= column) {
      current = `${current} ${word}`;
      continue;
    }

    lines.push(current);
    current = word;
  }

  if (current) {
    lines.push(current);
  }

  return lines.length > 0 ? lines : [""];
}

function escapeMarkdown(text) {
  return text.replace(/[\\`*_{}[\]()#+\-.!|>]/g, "\\$&");
}

async function openLocalManual(context, docs, target) {
  if (!target || !target.file) {
    return;
  }

  const config = vscode.workspace.getConfiguration("gapReference");
  const filePath = resolveManualFilePath(config, docs, target);
  if (!filePath) {
    vscode.window.showWarningMessage("GAP Reference Assistant has no configured GAP installation or manual path.");
    return;
  }

  const url = manualSectionUrl(filePath, target.anchor);
  const uri = await manualRedirectUri(context, url);
  await vscode.env.openExternal(uri);
}

class GapDebugAdapterDescriptorFactory {
  constructor(extensionPath, outputChannel) {
    this.extensionPath = extensionPath;
    this.outputChannel = outputChannel;
  }

  createDebugAdapterDescriptor() {
    const adapterPath = path.join(this.extensionPath, "debug", "gapDebugAdapter.js");
    this.outputChannel.appendLine(`Using GAP debug adapter: ${adapterPath}`);
    return new vscode.DebugAdapterExecutable(process.execPath, [adapterPath], {
      cwd: this.extensionPath,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1"
      }
    });
  }
}

class GapDebugConfigurationProvider {
  resolveDebugConfiguration(_folder, config) {
    const activeEditor = vscode.window.activeTextEditor;
    if (!config.type) {
      config.type = "gap";
    }
    if (!config.request) {
      config.request = "launch";
    }
    if (!config.name) {
      config.name = "Debug GAP File";
    }
    if (!config.program && activeEditor && activeEditor.document && activeEditor.document.languageId === "gap") {
      config.program = activeEditor.document.uri.fsPath;
    }
    return config;
  }
}

async function debugCurrentFile(resource, outputChannel = activeDebugOutputChannel) {
  const activeEditor = vscode.window.activeTextEditor;
  const uri = resource && resource.fsPath ? resource : (activeEditor && activeEditor.document && activeEditor.document.uri);
  if (!uri || !uri.fsPath) {
    vscode.window.showWarningMessage("Open a GAP file before starting the debugger.");
    return;
  }

  const document = activeEditor && activeEditor.document && activeEditor.document.uri.toString() === uri.toString()
    ? activeEditor.document
    : undefined;
  if (document && document.languageId !== "gap") {
    vscode.window.showWarningMessage("The active file is not a GAP file.");
    return;
  }
  if (document && document.isDirty) {
    const saved = await document.save();
    if (!saved) {
      vscode.window.showWarningMessage("Save the GAP file before starting the debugger.");
      return;
    }
  }

  const breakpoints = currentFileBreakpoints(uri);
  const configuration = {
    type: "gap",
    request: "launch",
    name: "Debug GAP File",
    program: uri.fsPath,
    breakpoints,
    stopOnEntry: false
  };

  if (outputChannel) {
    outputChannel.appendLine(`Starting GAP debug session for ${uri.fsPath}`);
    outputChannel.appendLine(`Captured ${breakpoints.length} breakpoint(s) for this file.`);
  }

  try {
    const started = await vscode.debug.startDebugging(vscode.workspace.getWorkspaceFolder(uri), configuration);
    if (!started) {
      if (outputChannel) {
        outputChannel.appendLine("VS Code returned false from debug.startDebugging before launching the adapter.");
        outputChannel.show(true);
      }
      vscode.window.showWarningMessage("GAP debugger did not start. See the GAP Debugger output channel for details.");
    }
  } catch (error) {
    if (outputChannel) {
      outputChannel.appendLine(`GAP debugger failed to start: ${error.message}`);
      outputChannel.show(true);
    }
    vscode.window.showErrorMessage(`GAP debugger failed to start: ${error.message}`);
  }
}

function currentFileBreakpoints(uri) {
  return (vscode.debug.breakpoints || [])
    .filter((breakpoint) => breakpoint.enabled !== false)
    .filter((breakpoint) => breakpoint.location && breakpoint.location.uri && breakpoint.location.uri.toString() === uri.toString())
    .map((breakpoint) => ({
      line: breakpoint.location.range.start.line + 1,
      column: breakpoint.location.range.start.character + 1
    }));
}

function resolveManualFilePath(config, docs, target) {
  const manualPath = resolveEntryManualPath(config, docs, target);
  return manualPath ? path.join(manualPath, target.file) : undefined;
}

function resolveEntryManualPath(config, docs, target = {}) {
  const manualRelativePath = normalizeManualRelativePath(target.manualRelativePath);
  const manualPath = normalizeSettingPath(config.get("manualPath", ""));
  const gapInstallationPath = normalizeSettingPath(config.get("gapInstallationPath", ""));

  if (manualRelativePath) {
    if (manualPath && isReferenceManualTarget(target, manualRelativePath)) {
      return manualPath;
    }
    if (gapInstallationPath) {
      return path.join(gapInstallationPath, ...manualRelativePath.split("/"));
    }

    const sourceManual = findSourceManual(docs, target, manualRelativePath);
    if (sourceManual && sourceManual.manualPath) {
      return sourceManual.manualPath;
    }

    if (docs && docs.source && docs.source.gapRoot) {
      return path.join(docs.source.gapRoot, ...manualRelativePath.split("/"));
    }
  }

  return resolveManualPath(config, docs);
}

function isReferenceManualTarget(target, manualRelativePath) {
  return target.manualId === "ref" || manualRelativePath === "doc/ref";
}

function findSourceManual(docs, target, manualRelativePath) {
  const manuals = docs && docs.source && Array.isArray(docs.source.manuals) ? docs.source.manuals : [];
  return manuals.find((manual) => {
    return (
      (target.manualId && manual.id === target.manualId) ||
      (manualRelativePath && normalizeManualRelativePath(manual.manualRelativePath) === manualRelativePath)
    );
  });
}

function resolveManualPath(config, docs) {
  const manualPath = normalizeSettingPath(config.get("manualPath", ""));
  if (manualPath) {
    return manualPath;
  }

  const gapInstallationPath = normalizeSettingPath(config.get("gapInstallationPath", ""));
  if (gapInstallationPath) {
    return path.join(gapInstallationPath, "doc", "ref");
  }

  return docs.source && docs.source.manualPath;
}

function normalizeSettingPath(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeManualRelativePath(value) {
  return typeof value === "string" ? value.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "") : "";
}

function manualSectionUri(filePath, anchor) {
  return vscode.Uri.parse(manualSectionUrl(filePath, anchor));
}

function manualSectionUrl(filePath, anchor) {
  const url = pathToFileURL(filePath).toString();
  return anchor ? `${url}#${encodeURIComponent(anchor)}` : url;
}

async function manualRedirectUri(context, targetUrl) {
  const storagePath = context.globalStorageUri.fsPath;
  await fs.promises.mkdir(storagePath, { recursive: true });

  const redirectPath = path.join(storagePath, "open-gap-reference.html");
  const html = `<!doctype html>
<meta charset="utf-8">
<title>Open GAP Reference</title>
<meta http-equiv="refresh" content="0; url=${escapeHtmlAttribute(targetUrl)}">
<script>
location.replace(${JSON.stringify(targetUrl)});
</script>
<p>Opening <a href="${escapeHtmlAttribute(targetUrl)}">${escapeHtml(targetUrl)}</a></p>
`;
  await fs.promises.writeFile(redirectPath, html, "utf8");
  return vscode.Uri.file(redirectPath);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeHtmlAttribute(value) {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

function truncate(text, maxLength) {
  if (!text || text.length <= maxLength) {
    return text;
  }

  const shortened = text.slice(0, Math.max(0, maxLength - 1)).trimEnd();
  return `${shortened}...`;
}

module.exports = {
  __test: {
    currentFileBreakpoints,
    debugCurrentFile,
    gapInlineValuesForDocument,
    groupEntries,
    resolveManualFilePath
  },
  activate,
  deactivate
};
