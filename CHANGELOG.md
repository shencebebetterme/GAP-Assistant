# Changelog

## 0.3.20

- Kept user-function parameter requirements from being narrowed by later call-site evidence.
- Stored compatible call-site filters separately as observed evidence for future analyzer use.
- Inferred element types for collection materializers such as `Elements`, `AsList`, `AsSet`, and `AsSSortedList`.
- Inferred `Elements(G)` and `AsList(G)` for group-like inputs as lists of group elements.

## 0.3.19

- Styled inferred type tokens with a distinct colored, bold code treatment in inference hovers.
- Enabled HTML rendering for extension hover markdown so the type styling appears in VS Code.

## 0.3.18

- Rendered variable and function inference hovers with the same highlighted snippet style.
- Removed redundant top-level `Type`, `Filters`, `Inputs`, and `Input filters` rows from inference hovers.
- Kept list element and record field details in a terse `Structure` section.

## 0.3.17

- Restyled static inference hovers with a compact code-style signature block.
- Displayed inferred list element types and record literal field types in variable hovers.
- Preserved container element and field metadata when merging/refining inferred types.

## 0.3.16

- Added diagnostics for clearly non-boolean `if`, `elif`, `while`, and `repeat ... until` conditions.
- Left unknown condition types alone, so user parameters and possible globals are not over-reported.

## 0.3.15

- Propagated definite local assignment through exhaustive `if`/`elif`/`else` branches.
- Treated terminating branches as non-reaching paths when deciding whether a local is assigned after a conditional.

## 0.3.14

- Tracked assignment state for declared local variables.
- Added diagnostics for declared locals read before they have an assigned value, including reads inside expressions and return statements.

## 0.3.13

- Carried positive filter evidence from failed negated predicates into later `elif` and `else` branches.
- Used false-branch flow from conditions such as `if not IsString(obj) then ... else ... fi` for hovers, return inference, operator diagnostics, and call checks.

## 0.3.12

- Added selector inference for list indexing, sublist selection, string indexing/slicing, and record fields.
- Preserved collection element filters through `list[i]`, `list{positions}`, and selectors chained after function calls.
- Added diagnostics for clear selector failures such as non-list bases, non-integer indices, non-list sublist positions, non-record field access, and unknown fields on record literals.

## 0.3.11

- Added GAP-reader-aligned inference for unary `not`, `mod`, `^`, and membership `in` expressions.
- Added diagnostics for clear operator failures such as non-boolean `not`, non-collection membership containers, invalid `mod`/`^` operands, and non-associative chained `^`.
- Tagged integer literals with positive and nonnegative filters when applicable.

## 0.3.10

- Added callback inference for `Filtered`, `ForAll`, and `ForAny`.
- Preserved collection element filters through `Filtered(...)` results and predicate callback parameters.
- Added diagnostics for `Filtered`, `ForAll`, and `ForAny` callbacks that clearly return non-boolean values.

## 0.3.9

- Added `repeat ... until` fallthrough filter flow from positive until predicates.
- Used repeat-until flow for hovers, diagnostics, returns, and post-loop call checks.

## 0.3.8

- Treated `ErrorNoReturn(...)` and `TryNextMethod()` as terminating statements for negative guard fallthrough flow.
- Used those guard exits for post-guard hovers, diagnostics, return inference, and call checks.

## 0.3.7

- Added fallthrough filter flow for terminating negative guard clauses such as `if not IsString(obj) then return fail; fi;`.
- Used post-guard flow for hovers, diagnostics, and returns after the guard.

## 0.3.6

- Added `while ... do` loop scopes with condition-derived predicate filters.
- Used while-loop condition flow for hovers, diagnostics, and returns inside loop bodies.

## 0.3.5

- Added `for ... in ... do` loop scopes with loop-variable filters inferred from the iterator element type.
- Used loop-variable flow for hovers, diagnostics, and returns inside loop bodies.

## 0.3.4

- Added `List(collection, x -> expr)` mapper inference, including result element types from the arrow body.
- Added arrow-parameter scopes for mapper hovers.
- Used input collection element filters when checking mapper body expressions and diagnostics.

## 0.3.3

- Added diagnostics for calls to user-defined functions when inferred parameter filters are clearly incompatible with the argument type.
- Kept bad user-function call-sites from polluting inferred parameter contracts.
- Applied branch-refined filters to user-function call checks.

## 0.3.2

- Added declaration-filter call diagnostics for clearly incompatible GAP operation arguments.
- Started checking standalone expression statements so unassigned calls can produce diagnostics.
- Kept call diagnostics flow-aware, so guarded calls use branch-refined filters.

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
