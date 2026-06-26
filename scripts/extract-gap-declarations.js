"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULT_GAP_ROOT = "C:\\Programs\\GAP-4.15.1\\runtime\\opt\\gap-4.15.1";
const OUTPUT_FILE = path.join(__dirname, "..", "data", "gap-declarations.json");
const DECLARE_NAMES = [
  "DeclareAttribute",
  "DeclareCategory",
  "DeclareConstructor",
  "DeclareFilter",
  "DeclareGlobalFunction",
  "DeclareOperation",
  "DeclareProperty",
  "DeclareRepresentation",
  "DeclareSynonym",
  "DeclareSynonymAttr"
];

function main() {
  const gapRoot = path.resolve(process.argv[2] || process.env.GAP_ROOT || DEFAULT_GAP_ROOT);
  const libPath = path.join(gapRoot, "lib");
  if (!fs.existsSync(libPath)) {
    fail(`GAP library directory does not exist: ${libPath}`);
  }

  const files = collectFiles(libPath).filter((file) => shouldReadFile(file));
  const declarationsByName = {};
  let declarationCount = 0;

  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    const relativeFile = path.relative(gapRoot, file).replace(/\\/g, "/");
    for (const call of findDeclareCalls(source)) {
      const declaration = declarationFromCall(call, source, relativeFile);
      if (!declaration) {
        continue;
      }

      if (!declarationsByName[declaration.name]) {
        declarationsByName[declaration.name] = [];
      }
      declarationsByName[declaration.name].push(declaration);
      declarationCount += 1;
    }
  }

  const names = Object.keys(declarationsByName).sort((left, right) => left.localeCompare(right));
  const output = {
    generatedAt: new Date().toISOString(),
    source: {
      gapRoot,
      libPath,
      generator: "scripts/extract-gap-declarations.js",
      filesRead: files.length
    },
    names,
    declarations: declarationsByName
  };

  fs.writeFileSync(`${OUTPUT_FILE}.tmp`, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  fs.renameSync(`${OUTPUT_FILE}.tmp`, OUTPUT_FILE);

  console.log(`Extracted ${declarationCount} GAP declarations for ${names.length} names from ${files.length} files.`);
  console.log(`Wrote ${OUTPUT_FILE}`);
}

function collectFiles(root) {
  const results = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFiles(fullPath));
    } else {
      results.push(fullPath);
    }
  }
  return results;
}

function shouldReadFile(file) {
  const base = path.basename(file);
  return file.endsWith(".gd") || base === "type.g" || base === "variable.g";
}

function findDeclareCalls(source) {
  const calls = [];
  const pattern = new RegExp(`\\b(${DECLARE_NAMES.join("|")})\\s*\\(`, "g");
  let match;

  while ((match = pattern.exec(source)) !== null) {
    const openParen = source.indexOf("(", match.index);
    const closeParen = findMatchingParen(source, openParen);
    if (closeParen < 0) {
      continue;
    }

    calls.push({
      callee: match[1],
      start: match.index,
      end: closeParen + 1,
      argsText: source.slice(openParen + 1, closeParen)
    });
    pattern.lastIndex = closeParen + 1;
  }

  return calls;
}

function declarationFromCall(call, source, relativeFile) {
  const args = splitTopLevel(call.argsText, ",").map((arg) => arg.trim()).filter(Boolean);
  if (args.length === 0) {
    return undefined;
  }

  const name = unquote(args[0]);
  if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    return undefined;
  }

  const declaration = {
    name,
    kind: kindFromCallee(call.callee),
    file: relativeFile,
    line: lineNumberAt(source, call.start),
    callee: call.callee
  };

  if (call.callee === "DeclareOperation" || call.callee === "DeclareConstructor") {
    declaration.argumentFilters = parseFilterList(args[1] || "");
    declaration.arity = declaration.argumentFilters.length;
  } else if (call.callee === "DeclareAttribute" || call.callee === "DeclareProperty") {
    declaration.argumentFilters = parseFilterExpression(args[1] || "");
    declaration.arity = declaration.argumentFilters.length > 0 ? 1 : undefined;
  } else if (call.callee === "DeclareCategory" || call.callee === "DeclareFilter" || call.callee === "DeclareRepresentation") {
    declaration.impliedFilters = parseFilterExpression(args[1] || "");
  } else if (call.callee === "DeclareSynonym" || call.callee === "DeclareSynonymAttr") {
    declaration.target = firstIdentifier(args[1] || "");
  }

  return declaration;
}

function kindFromCallee(callee) {
  return callee.replace(/^Declare/, "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

function parseFilterList(expression) {
  const trimmed = expression.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    return [];
  }

  return splitTopLevel(trimmed.slice(1, -1), ",").map((part) => parseFilterExpression(part));
}

function parseFilterExpression(expression) {
  return splitTopLevel(expression, "and")
    .flatMap((part) => splitTopLevel(part, "or"))
    .map(firstIdentifier)
    .filter((identifier) => identifier && /^Is[A-Za-z0-9_]+$/.test(identifier))
    .filter(uniqueFilter);
}

function firstIdentifier(expression) {
  const match = /\b[A-Za-z_][A-Za-z0-9_]*\b/.exec(expression);
  return match ? match[0] : undefined;
}

function uniqueFilter(value, index, values) {
  return values.indexOf(value) === index;
}

function findMatchingParen(source, openIndex) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "#") {
      while (index < source.length && source[index] !== "\n") {
        index += 1;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function splitTopLevel(text, delimiter) {
  const parts = [];
  let current = "";
  let depth = 0;
  let inString = false;
  let escaped = false;
  const wordDelimiter = /^[A-Za-z]+$/.test(delimiter);

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
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

    if (depth === 0 && matchesDelimiter(text, index, delimiter, wordDelimiter)) {
      parts.push(current);
      current = "";
      index += delimiter.length - 1;
      continue;
    }

    current += char;
  }

  if (current || text.endsWith(delimiter)) {
    parts.push(current);
  }
  return parts.map((part) => part.trim()).filter(Boolean);
}

function matchesDelimiter(text, index, delimiter, wordDelimiter) {
  if (text.slice(index, index + delimiter.length) !== delimiter) {
    return false;
  }
  if (!wordDelimiter) {
    return true;
  }
  const before = text[index - 1] || "";
  const after = text[index + delimiter.length] || "";
  return !/[A-Za-z0-9_]/.test(before) && !/[A-Za-z0-9_]/.test(after);
}

function unquote(value) {
  const match = /^"([^"]+)"$/.exec(value.trim());
  return match ? match[1] : undefined;
}

function lineNumberAt(source, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") {
      line += 1;
    }
  }
  return line;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

main();
