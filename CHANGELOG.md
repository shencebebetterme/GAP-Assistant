# Changelog

## 0.3.1

- Added branch-sensitive filter flow for simple positive GAP predicates such as `IsString(obj)` and `IsGroup(G)`.
- Used branch-refined filters for hovers, return inference, and operator diagnostics inside guarded `if` bodies.

## 0.3.0

- Added a GAP tokenizer and fault-tolerant parser layer modeled on GAP's `scanner.*` and `read.c` sources.
- Routed static inference through parsed assignment, local declaration, function, return, branch, and loop statements instead of relying on top-level regex scans.
- Exposed the parsed AST from analyzer results and added parser tests to the validation suite.

## 0.2.3

- Added basic operator-aware inference for numeric arithmetic such as `n + 10`.
- Added static diagnostics for likely operator runtime errors such as adding a string and an integer.
- Published diagnostics from the stdio language server and surfaced them through the VS Code extension.

## 0.2.2

- Fixed literal string inference for assignments and return expressions.
- Made static inference hovers more compact with a terse summary line and shorter labeled rows.

## 0.2.1

- Fixed hovers for inferred global variables, local variables, and user-defined functions that do not have manual documentation entries.
- Kept system-function inference hovers cleaner by hiding internal source, confidence, and documentation-return-hint lines.

## 0.2.0

- Added a standalone GAP analyzer and stdio language server prototype.
- Added static inference hovers for globals, locals, function returns, and documented callables.
- Represented inferred GAP values with filter sets instead of a single OO class-like type.
- Added analyzer and LSP smoke tests.

## 0.1.2

- Fixed local manual section links on Windows by opening through a browser redirect page that preserves anchors.

## 0.1.1

- Added configurable GAP installation path.
- Fixed local manual links to open exact section anchors.
- Improved structured hover rendering with manual examples.

## 0.1.0

- Initial local VS Code extension scaffold.
- Added GAP TextMate grammar and language configuration.
- Added generated GAP reference hover data support.
- Added documentation extraction and validation scripts.
