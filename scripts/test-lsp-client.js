"use strict";

const assert = require("assert");
const path = require("path");
const { GapLanguageServerClient } = require("../src/lspClient");

const root = path.resolve(__dirname, "..");
const serverPath = path.join(root, "server", "lsp-server.js");

function createDocument(uri, languageId, version, getText) {
  return {
    uri: {
      toString: () => uri
    },
    languageId,
    version,
    getText
  };
}

async function main() {
  const client = new GapLanguageServerClient(serverPath, {
    cwd: root,
    timeoutMs: 5000
  });

  try {
    let text = [
      "G := SymmetricGroup(4);",
      "str := \"hello\";",
      "gens := GeneratorsOfGroup(G);",
      "f := function(n)",
      "    local values;",
      "    values := List([1 .. n], i -> Factorial(i));",
      "    return values;",
      "end;",
      "uses := function(obj)",
      "    return Size(obj);",
      "end;",
      "uses(G);",
      ""
    ].join("\n");

    const document = createDocument("memory://client-test.g", "gap", 1, () => text);
    const groupHover = await client.hover(document, { line: 0, character: 1 });
    assert(groupHover.contents.value.includes("IsPermGroup"), "client hover should return server inference for variables");
    assert(!groupHover.contents.value.includes("Source:"), "client hover should not include internal source lines");

    const stringHover = await client.hover(document, { line: 1, character: 1 });
    assert(stringHover.contents.value.includes("`string`"), "client hover should infer string assignments");
    assert(stringHover.contents.value.includes("IsString"), "client hover should include IsString");

    const gensHover = await client.hover(document, { line: 2, character: 1 });
    assert(gensHover.contents.value.includes("IsList"), "client hover should return server inference for globals");

    const localHover = await client.hover(document, { line: 5, character: 6 });
    assert(localHover.contents.value.includes("IsList"), "client hover should return server inference for local variables");

    const functionHover = await client.hover(document, { line: 8, character: 1 });
    assert(functionHover.contents.value.includes("Input filters"), "client hover should return function input filters");
    assert(functionHover.contents.value.includes("IsListOrCollection"), "client hover should include body-derived filters");
    assert(functionHover.contents.value.includes("IsPermGroup"), "client hover should include call-site filters");
    assert(!functionHover.contents.value.includes("Confidence:"), "client hover should not include confidence lines");

    text = text.replace("SymmetricGroup(4)", "[1, 2, 3]");
    document.version = 2;

    const updatedHover = await client.hover(document, { line: 0, character: 1 });
    assert(updatedHover.contents.value.includes("IsList"), "client should synchronize changed documents");
  } finally {
    await client.dispose();
  }

  console.log("LSP client smoke test passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
