# GAP Reference Assistant

This workspace contains a local VS Code extension for GAP.

Features:

- GAP language registration for `.g`, `.gap`, `.gd`, `.gi`, and `.tst` files.
- TextMate syntax highlighting for GAP comments, strings, keywords, constants, operators, declarations, and function calls.
- Semantic highlighting for documented GAP reference symbols.
- Hover documentation for GAP reference manual functions and operations generated from the local GAP 4.15.1 reference manual HTML files.
- Structured hovers with section headings, styled inline code, grouped signatures, and GAP examples from the manual.
- Static GAP inference hovers for globals, locals, functions, return values, input filters, filter sets, and container structure.
- Local stdio GAP language server used by the extension for inference hovers.
- Fault-tolerant parser-backed analysis for assignments, local declarations, user functions, returns, branches, and loop bodies.
- Basic static diagnostics for likely runtime errors, including obvious invalid operator uses such as string-plus-integer arithmetic.
- Hover links that open the configured local manual page.

## Use In VS Code

Open this folder in VS Code and press `F5` to launch an Extension Development Host, or run VS Code with:

```powershell
code --extensionDevelopmentPath "C:\Users\Ce\Documents\codex_playground\GAP_frontend"
```

Open `examples/sample.g`, then hover names such as `SymmetricGroup`, `Size`, or `IsGroup`.

Static inference is filter-centric. A GAP value is modeled with every filter the analyzer can infer, for example `SymmetricGroup(4)` is a group object satisfying filters such as `IsGroup`, `IsPermGroup`, and `IsFinite`; this avoids pretending GAP has a single classical OO inheritance type. Hovers show the most useful result as a compact highlighted snippet, with inferred types styled distinctly from symbol names and container details such as `list[positive integer]` or record fields like `count: integer` kept in a terse structure section.

User-defined functions also get best-effort input filters. For example, if a parameter is passed to `Size(obj)` or `GeneratorsOfGroup(obj)`, the hover can show GAP declaration filters such as `IsListOrCollection` or `IsMagmaWithInverses`; if the function is later called with `SymmetricGroup(4)`, those call-site filters are merged as additional evidence.

Operator inference currently covers common arithmetic, comparison, boolean, membership, `mod`, and power forms following the precedence in GAP's reader. For example `m := n + 10;` can infer `m` as an integer after `n := 5;`, while `b := "hello" + 2;`, `not 3`, `1 in 5`, or `2 ^ 3 ^ 4` are reported as likely operator errors.

Control-flow conditions are checked when their type is clear. Expressions such as `if 3 then`, `elif "bad" then`, `while [1] do`, and `repeat ... until 5` are reported because GAP expects boolean conditions.

Selector inference follows GAP's term-level selector behavior. The analyzer can infer element filters for `gens[1]`, preserve element filters through `gens{[1]}`, infer characters and strings from string selectors, and use record literal field types for expressions such as `rec(count := 3).count`. Clear selector mistakes such as `5[1]`, `gens["x"]`, `gens{1}`, or `[1, 2].name` are reported.

Declared local variables are tracked for definite assignment. If a function declares `local value;` and then reads `value` before assigning to it, the checker reports the likely GAP runtime error; unknown identifiers that may be globals are still left alone.

Definite assignment also flows through conditionals. A local assigned in every reaching branch of an `if`/`elif`/`else` is treated as assigned after the conditional; branches that `return`, `ErrorNoReturn(...)`, or `TryNextMethod()` do not block that conclusion.

The analyzer also performs limited branch-sensitive filter flow. Inside a guarded block such as `if IsString(obj) then`, hovers, return inference, and operator diagnostics use `IsString` as evidence for `obj` in that branch.

Negated predicates are tracked on the false path when they can be represented positively. For example, inside the `else` branch of `if not IsString(obj) then ... else ... fi`, the analyzer treats `obj` as satisfying `IsString`; the same evidence is carried through later `elif` and `else` branches.

Call checking uses GAP declaration filters where available. For example, `GeneratorsOfGroup(5);` is reported because `GeneratorsOfGroup` resolves to a declaration requiring `IsMagmaWithInverses`, while a call guarded by `if IsGroup(obj) then` is treated as compatible in that branch.

The same compatibility check is applied to user-defined functions once their parameter filters have been inferred from the function body. For example, a function that calls `GeneratorsOfGroup(obj)` learns that `obj` should be group-like, and later calls with clearly incompatible arguments are reported without feeding that bad evidence back into the function contract.

Common mapper calls are analyzed as well. In `List([1 .. 4], i -> Factorial(i))`, the arrow parameter `i` is treated as an integer from the range element type, the result is inferred as a list of positive integers, and mistakes inside the mapper body can produce diagnostics.

Predicate callback calls are checked too. `Filtered(gens, g -> IsObject(g))` preserves the generator element filters in the filtered list, while `ForAll([1 .. 4], i -> i + 1)` is reported because the predicate body returns an integer instead of a boolean.

Loop variables also receive iterator element filters. In `for i in [1 .. 4] do`, `i` is treated as an integer inside the loop body; in `for g in GeneratorsOfGroup(G) do`, `g` inherits the generator element filters.

Loop conditions can refine symbols too. Inside `while IsString(obj) do`, the analyzer treats `obj` as satisfying `IsString` for hovers, return inference, and diagnostics in the loop body.

Terminating negative guards refine the following code path. After `if not IsString(obj) then return fail; fi;`, later statements in the same block treat `obj` as satisfying `IsString`.

The same fallthrough narrowing is applied for strong terminating guard calls such as `ErrorNoReturn(...)` and `TryNextMethod()`. Plain `Error(...)` is not currently treated as non-returning because GAP's break loop can be recoverable.

`repeat ... until` loops refine the following path from positive until predicates. After `repeat ... until IsGroup(obj);`, later statements treat `obj` as group-like.

Hover descriptions are hard-wrapped by default. Adjust `gapReference.hover.wrapColumn` in VS Code settings if you prefer wider or narrower documentation lines. Use `gapReference.hover.maxExamples` and `gapReference.hover.maxExampleLines` to control how many manual examples are shown.

## Regenerate Documentation Data

The checked-in hover data is generated from:

```text
C:\Programs\GAP-4.15.1\runtime\opt\gap-4.15.1\doc\ref
```

For hover links, set `gapReference.gapInstallationPath` to your GAP installation directory, for example:

```json
"gapReference.gapInstallationPath": "C:\\Programs\\GAP-4.15.1\\runtime\\opt\\gap-4.15.1"
```

If your reference manual is not under `doc/ref` inside the installation directory, set `gapReference.manualPath` directly to the manual HTML directory.

Regenerate it with:

```powershell
npm run extract-docs
```

Or pass a different manual directory:

```powershell
node scripts/extract-gap-docs.js "C:\path\to\gap\doc\ref"
```

Hover links open the exact local manual section anchor, for example `chap39.html#X7B75879B8085120A`.

## Validate

```powershell
npm run validate
```

## Language Server Prototype

The independent analyzer and minimal stdio language server live in `server/`.

```powershell
npm run language-server
```

The VS Code extension uses a lightweight local client in `src/lspClient.js` to request inference hovers from this server. The server currently supports initialization, full document sync, hover, and diagnostic publication; the extension still renders the manual documentation locally and falls back to the in-process analyzer if the server is unavailable.

The parser layer in `server/parser.js` is modeled against the installed GAP reader/scanner sources noted in `server/GAP_SOURCE_NOTES.md`. It is intended as the base for deeper filter-flow and runtime-risk checks, not as a complete replacement for GAP's own parser.

The generated documentation snippets come from the installed GAP reference manual. Keep GAP documentation licensing in mind if you redistribute the extension.
