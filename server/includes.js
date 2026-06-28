"use strict";

const fs = require("fs");
const path = require("path");
const { fileURLToPath, pathToFileURL } = require("url");

function findReadIncludes(ast) {
  const includes = [];
  collectStatementIncludes(ast && ast.statements, includes);
  return includes;
}

function collectStatementIncludes(statements, includes) {
  if (!Array.isArray(statements)) {
    return;
  }

  for (const statement of statements) {
    if (!statement) {
      continue;
    }

    if (statement.type === "expressionStatement") {
      const include = readIncludeFromExpression(statement.expression);
      if (include) {
        includes.push(include);
      }
    }

    if (Array.isArray(statement.body)) {
      collectStatementIncludes(statement.body, includes);
    }
    if (Array.isArray(statement.elseBody)) {
      collectStatementIncludes(statement.elseBody, includes);
    }
    if (Array.isArray(statement.branches)) {
      for (const branch of statement.branches) {
        collectStatementIncludes(branch && branch.body, includes);
      }
    }
  }
}

function readIncludeFromExpression(expression) {
  if (!expression || typeof expression.text !== "string") {
    return undefined;
  }

  const match = /^Read\s*\(\s*("(?:\\.|[^"\\])*")\s*\)$/.exec(expression.text.trim());
  if (!match) {
    return undefined;
  }

  const literal = match[1];
  const literalOffset = expression.text.indexOf(literal);
  const start = expression.start + Math.max(0, literalOffset);
  return {
    path: decodeGapStringLiteral(literal),
    literal,
    start,
    end: start + literal.length
  };
}

function decodeGapStringLiteral(literal) {
  const body = String(literal || "").replace(/^"/, "").replace(/"$/, "");
  const escapes = {
    "\"": "\"",
    "\\": "\\",
    n: "\n",
    r: "\r",
    t: "\t",
    b: "\b",
    f: "\f"
  };
  return body.replace(/\\(.)/g, (_match, char) => escapes[char] || char);
}

function createFileIncludeResolver(options = {}) {
  const readFileSync = options.readFileSync || ((filePath) => fs.readFileSync(filePath, "utf8"));

  return function resolveFileInclude(request) {
    const includePath = request && request.includePath;
    if (typeof includePath !== "string" || includePath.trim() === "") {
      return undefined;
    }

    for (const candidate of includeCandidates(request.fromUri, includePath, options)) {
      const resolvedPath = path.resolve(candidate);
      const uri = pathToUri(resolvedPath);
      const openText = readOpenDocumentText(options, uri, resolvedPath);
      if (typeof openText === "string") {
        return {
          uri,
          fsPath: resolvedPath,
          text: openText
        };
      }

      try {
        if (fs.statSync(resolvedPath).isFile()) {
          return {
            uri,
            fsPath: resolvedPath,
            text: readFileSync(resolvedPath)
          };
        }
      } catch (_) {
        // Try the next candidate.
      }
    }

    return undefined;
  };
}

function includeCandidates(fromUri, includePath, options) {
  const normalizedInclude = path.normalize(includePath);
  const candidates = [];
  if (path.isAbsolute(normalizedInclude)) {
    candidates.push(normalizedInclude);
  }

  const fromPath = fileUriToPath(fromUri);
  if (fromPath) {
    candidates.push(path.resolve(path.dirname(fromPath), normalizedInclude));
  }

  for (const root of optionValues(options.workspaceRoots)) {
    if (typeof root === "string" && root.trim() !== "") {
      candidates.push(path.resolve(root, normalizedInclude));
    }
  }

  candidates.push(path.resolve(process.cwd(), normalizedInclude));
  return uniquePaths(candidates);
}

function readOpenDocumentText(options, uri, fsPath) {
  for (const reader of [options.readDocumentText, options.readDocumentTextByUri]) {
    if (typeof reader === "function") {
      const value = tryRead(() => reader(uri));
      if (typeof value === "string") {
        return value;
      }
    }
  }

  if (typeof options.readDocumentTextByPath === "function") {
    const value = tryRead(() => options.readDocumentTextByPath(fsPath));
    if (typeof value === "string") {
      return value;
    }
  }

  return undefined;
}

function optionValues(value) {
  const resolved = typeof value === "function" ? tryRead(value) : value;
  if (!resolved) {
    return [];
  }
  return Array.isArray(resolved) ? resolved : [resolved];
}

function tryRead(reader) {
  try {
    return reader();
  } catch (_) {
    return undefined;
  }
}

function uniquePaths(paths) {
  const seen = new Set();
  const result = [];
  for (const filePath of paths) {
    const key = normalizePathKey(filePath);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(filePath);
  }
  return result;
}

function normalizePathKey(filePath) {
  if (typeof filePath !== "string" || filePath.trim() === "") {
    return "";
  }
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function fileUriToPath(uri) {
  if (typeof uri !== "string" || uri.trim() === "") {
    return undefined;
  }

  if (uri.startsWith("file:")) {
    try {
      return fileURLToPath(uri);
    } catch (_) {
      return undefined;
    }
  }

  return path.isAbsolute(uri) ? uri : undefined;
}

function pathToUri(filePath) {
  return pathToFileURL(path.resolve(filePath)).toString();
}

module.exports = {
  createFileIncludeResolver,
  fileUriToPath,
  findReadIncludes,
  pathToUri
};
