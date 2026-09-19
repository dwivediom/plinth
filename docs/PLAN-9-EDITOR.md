# Plan 9 — A Rich Editor

The brief: make the SQL editor feel like VS Code and DataGrip rather than a
text box. The first question is whether that means adopting Monaco.

## 0. Monaco, and why not

`PLAN.md` originally said "Monaco editor with schema-aware autocomplete"; the
build went to CodeMirror 6 instead. Revisiting that with numbers:

| | CodeMirror 6 | Monaco |
|---|---|---|
| Package, unpacked | ~300 KB core, add what you use | **97.9 MB** (≈5–10 MB shipped, plus workers) |
| Our app, installed | 18 MB today | a quarter to a half again on top |
| Already built on it | search, multi-cursor, schema completion, error decorations, statement-at-cursor, beautify, the AI's error underline | all of it re-done |
| SQL intelligence | ours to write | still ours to write — `monaco-sql-languages` is keyword and snippet completion for big-data dialects |

Monaco's real advantage is a language server. **There is no SQL language
server here to adopt** — the schema intelligence is ours either way, and we
already have the pieces nobody else has: the schema index, the FK join graph
from PLAN-6, and `sql_check` from PLAN-5.

So: stay on CodeMirror, and spend the weight on the parts a person actually
feels. The whole addition below is under 400 KB.

## 1. Colour and structure — the "VS Code" half

| Want | How | Size |
|---|---|---|
| Deep syntax colour | our own `HighlightStyle` over the lezer SQL tags — keywords, functions, types, strings, numbers, operators, comments each distinct | 0 |
| Rainbow brackets | a `ViewPlugin` over the visible ranges, depth → colour | 0 |
| Indentation guides | [`@replit/codemirror-indentation-markers`](https://github.com/replit/codemirror-indentation-markers) | 136 KB |
| Folding | `foldGutter` + `codeFolding` from `@codemirror/language` | 0 |
| Inline problems | `@codemirror/lint` | 97 KB |
| VS Code palette, if wanted | [`@uiw/codemirror-theme-vscode`](https://www.npmjs.com/package/@uiw/codemirror-theme-vscode) | 33 KB |

Sticky scroll and a minimap exist for CM6 too, but a SQL statement is rarely
long enough for either to earn its keep. Later, behind a setting.

## 2. Intelligence — the "DataGrip" half ⚠︎

This is the part worth building, because we can beat DataGrip at it rather
than imitate it.

- **Completion with substance**: tables carry their row estimate, columns
  carry their type and a key glyph, and each kind has its own icon — you can
  see what a suggestion *is* without reading it.
- **FK-aware JOIN completion**: typing `join` after `FROM orders` offers
  `JOIN customers ON orders.customer_id = customers.id`, built from the join
  graph. DataGrip's headline trick, and we already hold the graph.
- **Alias awareness**: `FROM orders o` then `o.` completes `orders`' columns.
- **Inspections**: an unknown table or column is underlined as you type, from
  the schema index — no round trip, no waiting for the server to reject it.

## 3. What this is not

Not a second editor engine, not a language server, and not a minimap nobody
asked for. Everything here is either a handful of lines over what CodeMirror
already exposes, or a small package with a clear job.

## 4. TODO

- [x] Syntax palette: nine token classes, VS Code Light+/Dark+ lineage, both
      appearances
- [x] Rainbow brackets (three depths, syntax-tree aware so a parenthesis in a
      string is left alone), indentation guides, folding gutter
- [x] **Identifiers coloured from the schema** — lang-sql emits no tag for a
      bare identifier, which is why every other client's SQL looks flat. A
      name that is a table reads as a table; a column reads as a column
- [x] Completion with substance: schema and row estimate on tables, owning
      table on columns, icons per kind
- [x] JOIN completion from the FK graph — `payments ON orders.payment_id =
      payments.id`, ranked first, labelled "foreign key"
- [x] Alias-aware column completion (`o.` → that table's columns only)
- [ ] Inspections for unknown tables and columns — deferred deliberately:
      without alias resolution it underlines every alias, and a false
      positive here is worse than no warning
- [ ] Optional: sticky scroll, minimap, VS Code palette as a theme choice

### A note for whoever touches completion next

Registering our source through `EditorState.languageData` *looked* correct and
failed silently: the source ran, produced the right options, and none of them
reached the popup. `autocompletion({ override: [ours, keywordCompletionSource(dialect)] })`
is explicit and works. Don't go back.
