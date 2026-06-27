# GAP Source Anchors

The extension parser is modeled against the installed GAP 4.15.1 reader and scanner sources:

- `src/scanner.h` defines token classes such as `S_ASSIGN`, `S_IF`, `S_RETURN`, arithmetic operators, relational operators, `EXPRBEGIN`, and `STATBEGIN`.
- `src/scanner.c` implements identifier, keyword, string, integer, and operator scanning.
- `src/read.c` is GAP's recursive-descent reader:
  - `ReadLiteral`, `ReadTerm`, `ReadAri`, `ReadRel`, `ReadAnd`, and `ReadExpr` define expression precedence.
  - `ReadFactor`, `ReadTerm`, and `ReadRel` define `^`, `mod`, repeated `not`, and membership `in`; chained top-level `^` is rejected as non-associative.
  - `ReadSelector` and `ReadReferenceModifiers` define chained calls, list selectors, sublist selectors, and record selectors as term-level modifiers.
  - `ReadIf` defines `if`/`elif`/`else`/`fi`.
  - `ReadReturn` defines `return [ <Expr> ];`.
  - `ReadStats` documents the statement forms handled by the reader.

The local parser in `server/parser.js` is not a full reimplementation of GAP's interpreter reader. It is a fault-tolerant AST layer for editor analysis, currently covering tokens, assignments, function literals assigned to names, local declarations, returns, conditionals, and basic loop bodies.
