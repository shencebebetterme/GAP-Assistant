"use strict";

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const vscode = require("vscode");
const { getEntries, isIdentifier, loadDeclarations, loadDocumentation } = require("./docs");
const { GapAnalyzer, formatInferenceMarkdown } = require("../server/analyzer");

const GAP_SELECTOR = { language: "gap" };
const IDENTIFIER_PATTERN = /[A-Za-z_][A-Za-z0-9_]*/;
const SEMANTIC_LEGEND = new vscode.SemanticTokensLegend(["function"], []);

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

  context.subscriptions.push(
    vscode.languages.registerHoverProvider(GAP_SELECTOR, new GapHoverProvider(docs, analyzer)),
    vscode.languages.registerDocumentSemanticTokensProvider(
      GAP_SELECTOR,
      new GapSemanticTokensProvider(docs),
      SEMANTIC_LEGEND
    ),
    vscode.commands.registerCommand("gapReference.openLocalManual", (target) => openLocalManual(context, docs, target))
  );
}

function deactivate() {}

class GapHoverProvider {
  constructor(docs, analyzer) {
    this.docs = docs;
    this.analyzer = analyzer;
    this.analysisCache = new Map();
  }

  provideHover(document, position) {
    const range = document.getWordRangeAtPosition(position, IDENTIFIER_PATTERN);
    if (!range) {
      return undefined;
    }

    const name = document.getText(range);
    const entries = getEntries(this.docs, name);
    const inferenceHover = this.inferenceHover(document, position);
    if ((!entries || entries.length === 0) && !inferenceHover) {
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
    markdown.isTrusted = {
      enabledCommands: ["gapReference.openLocalManual"]
    };

    if (inferenceHover) {
      markdown.appendMarkdown(formatInferenceMarkdown(inferenceHover));
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

      const meta = [group.entry.kind, group.entry.section ? `section ${group.entry.section}` : undefined]
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

      markdown.appendMarkdown(`[$(book) Open full local GAP reference](${manualCommandUri(group.entry)})`);

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
        name: entry.name
      }
    ])
  );
  return `command:gapReference.openLocalManual?${payload}`;
}

function groupEntries(entries) {
  const groupsByKey = new Map();

  for (const entry of entries) {
    const key = [
      entry.anchor,
      entry.file,
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
  const manualPath = resolveManualPath(config, docs);
  if (!manualPath) {
    vscode.window.showWarningMessage("GAP Reference Assistant has no configured GAP installation or manual path.");
    return;
  }

  const url = manualSectionUrl(path.join(manualPath, target.file), target.anchor);
  const uri = await manualRedirectUri(context, url);
  await vscode.env.openExternal(uri);
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
  activate,
  deactivate
};
