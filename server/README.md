# GAP Language Server Prototype

This directory contains a dependency-free GAP language analysis engine and a
minimal stdio Language Server Protocol wrapper.

The analyzer models GAP values as a label plus a set of filters. This is
intentional: GAP objects can satisfy several filters at once, and GAP's object
system is not classical single-inheritance OO. For example, a value inferred
from `SymmetricGroup(4)` is represented with filters such as `IsObject`,
`IsCollection`, `IsGroup`, `IsPermGroup`, and `IsFinite`.

Current static inference covers:

- global and local assignment symbols
- function parameters and `local` declarations
- function return expressions
- literals: integers, rationals, booleans, strings, lists, records, permutations
- common GAP constructors and operations such as `SymmetricGroup`,
  `GroupWithGenerators`, `GeneratorsOfGroup`, `Size`, `Length`, and `List`
- documentation-derived callable signatures and return hints from
  `data/gap-docs.json`
- GAP library declaration filters from `data/gap-declarations.json`, including
  declaration synonyms such as `GeneratorsOfGroup` mapping to the underlying
  `GeneratorsOfMagmaWithInverses` attribute

Run the stdio server with:

```powershell
node server/lsp-server.js
```

The VS Code extension currently calls the analyzer directly for hover
inference. The stdio server is present so a future `vscode-languageclient`
integration can delegate to the same independent engine.
