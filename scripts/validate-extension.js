"use strict";

const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");
const { getEntries, isIdentifier } = require("../src/docs");

const ROOT = path.resolve(__dirname, "..");
const REQUIRED_FILES = [
  "package.json",
  "language-configuration.json",
  "syntaxes/gap.tmLanguage.json",
  "data/gap-declarations.json",
  "debug/gapDebugAdapter.js",
  "debug/instrumenter.js",
  "server/analyzer.js",
  "server/parser.js",
  "server/lsp-server.js",
  "src/docs.js",
  "src/extension.js",
  "src/lspClient.js",
  "data/gap-docs.json"
];

function main() {
  const failures = [];

  for (const file of REQUIRED_FILES) {
    if (!fs.existsSync(path.join(ROOT, file))) {
      failures.push(`Missing required file: ${file}`);
    }
  }

  const packageJson = readJson("package.json", failures);
  const languageConfiguration = readJson("language-configuration.json", failures);
  const grammar = readJson("syntaxes/gap.tmLanguage.json", failures);
  const docs = readJson("data/gap-docs.json", failures);
  const declarations = readJson("data/gap-declarations.json", failures);

  if (packageJson) {
    if (packageJson.main !== "./src/extension.js") {
      failures.push("package.json main must point to ./src/extension.js");
    }
    if (!packageJson.contributes || !Array.isArray(packageJson.contributes.languages)) {
      failures.push("package.json must contribute a GAP language");
    }
    if (!packageJson.contributes || !Array.isArray(packageJson.contributes.grammars)) {
      failures.push("package.json must contribute a TextMate grammar");
    }
    const debuggers = packageJson.contributes && Array.isArray(packageJson.contributes.debuggers)
      ? packageJson.contributes.debuggers
      : [];
    if (!debuggers.some((debuggerContribution) => debuggerContribution.type === "gap" && debuggerContribution.program === "./debug/gapDebugAdapter.js")) {
      failures.push("package.json must contribute the GAP debug adapter");
    }
  }

  if (languageConfiguration && !languageConfiguration.comments) {
    failures.push("language-configuration.json must define comments");
  }

  if (grammar) {
    if (grammar.scopeName !== "source.gap") {
      failures.push("GAP grammar scopeName must be source.gap");
    }
    if (!Array.isArray(grammar.patterns) || !grammar.repository) {
      failures.push("GAP grammar must contain patterns and repository");
    }
  }

  for (const file of [
    "server/analyzer.js",
    "server/parser.js",
    "server/lsp-server.js",
    "debug/gapDebugAdapter.js",
    "debug/instrumenter.js",
    "src/lspClient.js",
    "scripts/test-parser.js",
    "scripts/test-analyzer.js",
    "scripts/test-extension-helpers.js",
    "scripts/test-lsp-server.js",
    "scripts/test-lsp-client.js",
    "scripts/test-debug-instrumenter.js",
    "scripts/test-debug-adapter.js"
  ]) {
    try {
      childProcess.execFileSync(process.execPath, ["--check", path.join(ROOT, file)], {
        stdio: "pipe"
      });
    } catch (error) {
      failures.push(`${file} should pass node --check: ${error.message}`);
    }
  }

  if (docs) {
    validateDocs(docs, failures);
  }
  if (declarations) {
    validateDeclarations(declarations, failures);
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exit(1);
  }

  console.log(`Validated GAP extension files.`);
  console.log(`Documentation names: ${docs.names.length}`);
  console.log(`Reference entries: ${Object.values(docs.entries).reduce((sum, entries) => sum + entries.length, 0)}`);
}

function validateDeclarations(declarations, failures) {
  if (!declarations.declarations || typeof declarations.declarations !== "object") {
    failures.push("data/gap-declarations.json must contain a declarations object");
    return;
  }
  if (!Array.isArray(declarations.names) || declarations.names.length < 1000) {
    failures.push("data/gap-declarations.json should contain at least 1000 declared GAP names");
    return;
  }

  const size = declarations.declarations.Size && declarations.declarations.Size[0];
  if (!size || !size.argumentFilters || !size.argumentFilters[0].includes("IsListOrCollection")) {
    failures.push("Size declaration should include IsListOrCollection input filter");
  }

  const generators = declarations.declarations.GeneratorsOfGroup && declarations.declarations.GeneratorsOfGroup[0];
  if (!generators || generators.target !== "GeneratorsOfMagmaWithInverses") {
    failures.push("GeneratorsOfGroup declaration should preserve synonym target");
  }
}

function validateDocs(docs, failures) {
  if (!docs.entries || typeof docs.entries !== "object") {
    failures.push("data/gap-docs.json must contain an entries object");
    return;
  }

  if (!Array.isArray(docs.names) || docs.names.length < 500) {
    failures.push("data/gap-docs.json should contain at least 500 documented GAP names");
    return;
  }

  const sourceManuals = docs.source && Array.isArray(docs.source.manuals) ? docs.source.manuals : [];
  const packageManuals = sourceManuals.filter((manual) => manual.type === "package");
  if (packageManuals.length < 160) {
    failures.push("data/gap-docs.json should include installed GAP package manuals");
  }

  for (const required of ["NameFunction", "DeclareOperation", "Size", "IsGroup", "GeneratorsOfGroup"]) {
    const entries = getEntries(docs, required);
    if (!entries || entries.length === 0) {
      failures.push(`Missing required GAP documentation entry: ${required}`);
      continue;
    }
    if (!entries[0].signature || !entries[0].description) {
      failures.push(`Documentation entry ${required} must have a signature and description`);
    }
  }

  const generatorsEntry = docs.entries.GeneratorsOfGroup && docs.entries.GeneratorsOfGroup[0];
  if (!generatorsEntry || !Array.isArray(generatorsEntry.blocks)) {
    failures.push("GeneratorsOfGroup should include structured hover blocks");
  } else if (!generatorsEntry.blocks.some((block) => block.type === "example" && /GeneratorsOfGroup/.test(block.code))) {
    failures.push("GeneratorsOfGroup should include its manual example block");
  }

  validatePackageDocEntry(docs, failures, "Digraph", "pkg:digraphs");
  validatePackageDocEntry(docs, failures, "ACECosetTable", "pkg:ace");

  const identifierNames = docs.names.filter(isIdentifier);
  if (identifierNames.length < 400) {
    failures.push("Too few identifier-like GAP symbols for semantic highlighting");
  }
}

function validatePackageDocEntry(docs, failures, name, expectedManualId) {
  const entries = getEntries(docs, name);
  const entry = entries && entries.find((candidate) => candidate.manualId === expectedManualId);
  if (!entry) {
    failures.push(`Missing package documentation entry ${name} from ${expectedManualId}`);
    return;
  }
  if (!entry.manualRelativePath || !entry.file || !entry.anchor) {
    failures.push(`Package documentation entry ${name} should include local manual link metadata`);
  }
}

function readJson(relativePath, failures) {
  const fullPath = path.join(ROOT, relativePath);
  try {
    return JSON.parse(fs.readFileSync(fullPath, "utf8"));
  } catch (error) {
    failures.push(`${relativePath} is not valid JSON: ${error.message}`);
    return undefined;
  }
}

main();
