"use strict";

const fs = require("fs");
const path = require("path");

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

let cachedDocs;
let cachedDeclarations;

function loadDocumentation(extensionPath) {
  if (cachedDocs) {
    return cachedDocs;
  }

  const docsPath = path.join(extensionPath, "data", "gap-docs.json");
  const raw = fs.readFileSync(docsPath, "utf8");
  const docs = JSON.parse(raw);

  if (!docs || !docs.entries || !Array.isArray(docs.names)) {
    throw new Error(`${docsPath} is not a valid GAP documentation data file`);
  }

  cachedDocs = docs;
  return docs;
}

function loadDeclarations(extensionPath) {
  if (cachedDeclarations) {
    return cachedDeclarations;
  }

  const declarationsPath = path.join(extensionPath, "data", "gap-declarations.json");
  const raw = fs.readFileSync(declarationsPath, "utf8");
  const declarations = JSON.parse(raw);

  if (!declarations || !declarations.declarations || !Array.isArray(declarations.names)) {
    throw new Error(`${declarationsPath} is not a valid GAP declarations data file`);
  }

  cachedDeclarations = declarations;
  return declarations;
}

function getEntries(docs, name) {
  const direct = docs.entries[name];
  if (direct && direct.length > 0) {
    return direct;
  }

  const generated = generatedAccessorEntries(docs, name);
  return generated.length > 0 ? generated : undefined;
}

function generatedAccessorEntries(docs, name) {
  const match = /^(Has|Set)([A-Z][A-Za-z0-9_]*)$/.exec(name);
  if (!match) {
    return [];
  }

  const [, prefix, baseName] = match;
  const baseEntries = docs.entries[baseName];
  if (!baseEntries || baseEntries.length === 0) {
    return [];
  }

  const attributeEntries = baseEntries.filter((entry) =>
    ["attribute", "property"].includes((entry.kind || "").toLowerCase())
  );
  const sourceEntries = attributeEntries.length > 0 ? attributeEntries : baseEntries;

  return sourceEntries.map((entry) => {
    const isTester = prefix === "Has";
    const kind = isTester ? `${entry.kind || "attribute"} tester` : `${entry.kind || "attribute"} setter`;
    const action = isTester
      ? `tests whether a value for ${baseName} is known for the object`
      : `sets the stored value of ${baseName} for the object`;

    return {
      ...entry,
      name,
      kind,
      signature: `${name}( obj )`,
      description: `${name} is generated for ${baseName}; it ${action}. ${entry.description || ""}`.trim(),
      blocks: [
        {
          type: "paragraph",
          markdown: `\`${name}\` is generated for \`${baseName}\`; it ${action}.`
        }
      ],
      generated: true
    };
  });
}

function isIdentifier(text) {
  return IDENTIFIER_RE.test(text);
}

module.exports = {
  getEntries,
  isIdentifier,
  loadDeclarations,
  loadDocumentation
};
