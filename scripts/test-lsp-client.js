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
      "n := 5;",
      "m := n + 10;",
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
    assert(groupHover.contents.value.includes("G := symmetric permutation group;"), "client hover should return server inference for variables");
    assert(!groupHover.contents.value.includes("Source:"), "client hover should not include internal source lines");

    const operatorHover = await client.hover(document, { line: 2, character: 1 });
    assert(operatorHover.contents.value.includes("m := integer;"), "client hover should infer integer arithmetic");

    const stringHover = await client.hover(document, { line: 3, character: 1 });
    assert(stringHover.contents.value.includes("str := string;"), "client hover should infer string assignments");

    const gensHover = await client.hover(document, { line: 4, character: 1 });
    assert(gensHover.contents.value.includes("gens := list of group generators[group element];"), "client hover should return server inference for globals");
    assert(gensHover.contents.value.includes("- element: `group element`"), "client hover should include global container structure");

    const localHover = await client.hover(document, { line: 7, character: 6 });
    assert(localHover.contents.value.includes("values := list[positive integer];"), "client hover should return server inference for local variables");
    assert(localHover.contents.value.includes("- element: `positive integer`"), "client hover should include local container structure");

    const functionHover = await client.hover(document, { line: 10, character: 1 });
    assert(functionHover.contents.value.includes("uses(obj: permutation group)"), "client hover should return inferred function input type in the signature");
    assert(!functionHover.contents.value.includes("Input filters"), "client hover should not repeat function input filters");
    assert(!functionHover.contents.value.includes("Confidence:"), "client hover should not include confidence lines");

    text = text.replace("SymmetricGroup(4)", "[1, 2, 3]");
    document.version = 2;

    const updatedHover = await client.hover(document, { line: 0, character: 1 });
    assert(updatedHover.contents.value.includes("G := list[integer];"), "client should synchronize changed documents");
  } finally {
    await client.dispose();
  }

  console.log("LSP client smoke test passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
