# Changelog

## 0.4.4

- Added **GAP: Debug Current Notebook Cell** for GAP code cells in notebooks, using the existing GAP debugger with notebook-cell source mapping.

## 0.4.3

- Fixed nested `List(..., i -> List(..., j -> ...))` callback inference so analyzer hovers keep working.

## 0.4.2

- Recognized user-defined functions from files loaded with `Read("...")` for static analysis, diagnostics, and hover.

## 0.4.1

- Added the GAP Assist extension icon for Marketplace and VS Code extension views.

## 0.4.0

- Renamed the extension to GAP Assist for Marketplace publication.
- Accepted GAP permutation multiplication such as `perm1 * perm2` in static operator analysis.
- Colored GAP word operators such as `and`, `or`, and `not` with the regular keyword scope.
- Removed generated local installation paths from packaged documentation/declaration data.
- Rewrote the README around public extension features, settings, screenshots, and publishing steps.

## 0.3.41

- Left-aligned user function `##` documentation hovers while preserving the `Documentation` heading and line breaks.

## 0.3.40

- Moved GAP hover markdown rendering out of `server/analyzer.js` into `server/hoverFormatter.js`.
- Switched compact inference hovers to syntax-highlightable `gap` code blocks so VS Code preserves coloring.
- Added grammar scopes for inferred type labels used in hover signatures and member rows.
- Restyled user function `##` doc comments as a readable documentation block.

## 0.3.39

- Restored colored hover tokens for compact function and variable inference without bold type styling.
- Rendered user function doc comments on explicit hover lines for summaries, parameters, and returns.
- Added compact member/type rows for container and record variable hovers.

## 0.3.38

- Simplified GAP inference hovers to compact colored one-line type signatures for functions and variables.
- Kept user function `##` doc comments available without inferred parameter/return sections.

## 0.3.37

- Added `##`/`#!` doc-comment hovers for user-defined GAP functions, including `@param` and `@returns` sections.
- Rendered GAP function hover signatures as syntax-highlighted `gap` code blocks with styled parameter and return details.

## 0.3.36

- Added a red whole-line editor highlight for GAP runtime errors.
- Expanded GAP exception popup details with the runtime error message, source location, and stack context.

## 0.3.35

- Kept the GAP debugger paused on runtime errors so inline values and variable scopes remain available.
- Rewrote generated `.debug.g` runtime error locations back to the original GAP source file and line.

## 0.3.34

- Added inline debug values for active function parameters at their declaration positions.

## 0.3.33

- Added inline debug values for GAP assignment targets while paused.
- Skipped function definitions and record fields when placing inline debug values.

## 0.3.32

- Kept debug hover from overriding static GAP hovers for functions and uncaptured GAP symbols.
- Compacted instrumented GAP function values in the debugger variable panel.

## 0.3.31

- Split GAP debugger variables into separate `Locals` and `Globals` scopes.
- Classified function parameters, local declarations, and loop variables as locals while preserving top-level bindings as globals.

## 0.3.30

- Fixed Windows source path decoding in the GAP debugger so paths ending in segments such as `test.g` do not lose `\t` as a tab escape.

## 0.3.29

- Registered the GAP debug adapter from the extension activation path so `GAP: Debug Current File` can start the adapter reliably.
- Added a GAP debug configuration provider and a `GAP Debugger` output channel for startup diagnostics.

## 0.3.28

- Passed current-file breakpoints directly when running `GAP: Debug Current File`, making command-launched sessions stop reliably.
- Forwarded GAP output that is printed without a trailing newline before the next debug probe or process exit.
- Added a workspace `Debug GAP File` launch configuration alongside the extension-host development configuration.

## 0.3.27

- Enabled gutter breakpoints for GAP files through VS Code's breakpoint language contribution.
- Added `GAP: Debug Current File` to the command palette, editor title run menu, and editor context menu.

## 0.3.26

- Added an experimental VS Code debugger for GAP files.
- Supported line breakpoints, statement-level `next`, `stepIn`, and `stepOut`, and runtime variable capture for hover/watch evaluation.
- Documented GAP debugger launch configuration and default WSL launch behavior.

## 0.3.25

- Added stricter structured return inference for documented algebraic objects such as magmas, semigroups, monoids, mappings, homomorphisms, and matrices.
- Fixed constructors such as `Magma`, `MathieuGroup`, `SubgroupShell`, `IdentityMat`, and `PermutationMat` so incidental list/dimension prose does not override the actual return object.
- Classified determinant/permanent-style matrix functions as scalar/ring-element returns instead of matrix returns.
- Preferred the first explicit `returns ...` sentence before later fallback sentences such as `Name returns fail`.
- Improved integer return inference for documented finite-field vector helpers such as `NumberFFVector`, `WeightVecFFE`, and `DistanceVecFFE`.

## 0.3.24

- Fixed group constructor hovers such as `SymmetricGroup` and `AlternatingGroup` so degree prose is not misread as an integer return type.
- Preferred high-confidence analyzer return models for known GAP calls in system hovers, including precise generator-list element types.
- Inferred documented signature parameter types for common GAP prose patterns such as optional filters, degree/rank integers, list-of-integers arguments, and group/subgroup parameters.
- Aligned diagnostics with omitted optional signature parameters, so calls like `SymmetricGroup(4)` and `SymmetricGroup(IsPermGroup, 4)` check the actual degree argument.
- Added element-type checks for clear list-argument mismatches such as passing a string where `list[integer]` is expected.
- Tightened filter compatibility so broad supertypes such as `IsCollection` do not satisfy more specific group requirements.

## 0.3.23

- Reworked documentation-derived return inference to use explicit return/value clauses instead of scanning whole prose blocks.
- Fixed false list/group/integer returns caused by incidental argument prose such as list inputs, subgroup descriptions, and generator counts.
- Rendered documented GAP/package variables as values instead of system functions.
- Split optional signature parameter groups such as `Gcd([R,]r1,r2,...)` and `Digraph([filt,]obj[,source,range])` into separate hover parameters.

## 0.3.22

- Fixed documented `Gcd` inference so the list-argument overload does not imply a list return.
- Displayed generic `Gcd` hovers as returning a single ring element.
- Inferred integer results for statically numeric `Gcd` calls such as `Gcd([10, 15])`, `Gcd(10, 15)`, and `Gcd(Integers, [10, 15])`.

## 0.3.21

- Extended generated hover documentation to installed GAP package manuals.
- Added extraction for both GAPDoc package manuals under `pkg/*/doc` and legacy package manuals under `pkg/*/htm` or `pkg/*/doc/htm/*`.
- Preserved package manual metadata in hover entries so local links open package pages as well as core reference pages.
- Added validation coverage for GAPDoc-style and legacy-style package documentation entries.

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
