# GAP Reference Assistant

This workspace contains a local VS Code extension for GAP.

Features:

- GAP language registration for `.g`, `.gap`, `.gd`, `.gi`, and `.tst` files.
- TextMate syntax highlighting for GAP comments, strings, keywords, constants, operators, declarations, and function calls.
- Semantic highlighting for documented GAP reference symbols.
- Hover documentation for GAP reference manual functions and operations generated from the local GAP 4.15.1 reference manual HTML files.
- Structured hovers with section headings, styled inline code, grouped signatures, and GAP examples from the manual.
- Static GAP inference hovers for globals, locals, functions, return values, input filters, and filter sets.
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

Static inference is filter-centric. A GAP value is shown with every filter the analyzer can infer, for example `SymmetricGroup(4)` is a group object satisfying filters such as `IsGroup`, `IsPermGroup`, and `IsFinite`; this avoids pretending GAP has a single classical OO inheritance type.

User-defined functions also get best-effort input filters. For example, if a parameter is passed to `Size(obj)` or `GeneratorsOfGroup(obj)`, the hover can show GAP declaration filters such as `IsListOrCollection` or `IsMagmaWithInverses`; if the function is later called with `SymmetricGroup(4)`, those call-site filters are merged as additional evidence.

Operator inference currently covers common arithmetic, comparison, and boolean forms. For example `m := n + 10;` can infer `m` as an integer after `n := 5;`, while `b := "hello" + 2;` is reported as a likely operator error.

The analyzer also performs limited branch-sensitive filter flow. Inside a guarded block such as `if IsString(obj) then`, hovers, return inference, and operator diagnostics use `IsString` as evidence for `obj` in that branch.

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
