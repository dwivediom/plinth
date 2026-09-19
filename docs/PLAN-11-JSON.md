# Plan 11 — The JSON Viewer

## 0. What the good ones do

Before building, the field. [JSON Editor Online / svelte-jsoneditor](https://github.com/josdejong/svelte-jsoneditor)
is the reference implementation: three modes (tree, table, text), query and
transform, repair, JSON Schema validation, and a CodeMirror 6 text pane.
[Dadroit](https://dadroit.com/blog/open-big-json/) and
[bigJson](https://hi-malay.github.io/bigjson/) are the large-file answer, and
both work the same way — parse into a flat index, then render only the rows on
screen, so memory tracks file size instead of 3–10×.
[JSON Crack](https://jsoncrack.com) does the graph view.
The query layer is split between [JSONPath](https://en.wikipedia.org/wiki/JSONPath)
and jq, with JSONPath the de-facto standard in editors.

So the baseline a person expects: tree and raw text, expand/collapse, search,
copyable paths, format and minify, and something that does not fall over on a
big document.

## 1. Built, not borrowed

`svelte-jsoneditor` is the best of them and it was still the wrong choice
here. It brings Svelte and its own visual language into a React app whose
first requirement was that this look like part of the app rather than a widget
bolted into it. And the part that actually matters — staying fast on a
document with hundreds of thousands of nodes — is not something a library
gives you for free: it is a flat index plus a virtualiser, and this app
already has the virtualiser it uses for the data grid.

## 2. The flat index

`lib/json/model.ts` walks the document **once** into an array, each node
recording `parent`, `depth`, and `end` — the index just past its last
descendant. Three properties follow:

- **Collapsing is O(1).** A closed container is skipped with `i = node.end`,
  not by traversing it, so the visible-row list is proportional to what is on
  screen rather than to the document.
- **Search is one linear scan**, and because each node knows whether the hit
  was a key or a value, "keys only" and "values only" are free. That is the
  control people actually reach for: `id` is in half the keys of a real
  document and in none of the values they were looking for.
- **Nothing recurses.** The flatten uses an explicit stack, which is the
  difference between opening a pathologically nested document and a blank tab.

Measured on this machine, 200,002 nodes: **flatten 17 ms, visible rows 2 ms,
search 6 ms**. In the app, a 4.2 MB paste (200,003 nodes) renders immediately
and a search for a value in row 19,998 finds and reveals it with no pause.

## 3. Where it appears

| | |
|---|---|
| **In a cell** | A `json` cell carries a `{}` glyph on hover — the column stays readable, and the document is one click from the grid |
| **Beside the grid** | The inspector shows it in place, so the row stays visible — **the same viewer at every size**, because two renderers for one thing is how a two-key object ends up laid out differently from a two-thousand-key one. The panel is as tall as its document, up to fourteen rows, and the toolbar drops to what fits a 190px column |
| **Enlarged** | ⤢ opens the full viewer over the app, with every control and the table still behind it. Escape puts it back. The side panel is the right size for a glance and the wrong size for reading |
| **In its own tab** | From the glyph, or from the inspector's *open in a tab*. It owns its text, so it outlives the row |
| **Empty, to paste into** | `⌘⇧J`, File → New JSON Viewer |
| **With no database at all** | *JSON Viewer* on the launcher — the state people are in when someone sends them a payload and asks what is wrong with it |

## 4. What it does

Tree and raw text; expand all / collapse all / two levels; search scoped to
keys, values or both, with match case, regular expressions, next/previous, and
a filter that shows only matches and the path down to them; select a node for
its JSONPath, its Postgres accessor (`meta -> 'address' ->> 'city'`) or its
value; format and minify; and a parse error that shows the text around the
offset rather than only the message.

## 5. Opening what will not parse

`JSON.parse` is all or nothing. One stray comma in a 40 MB payload and you get
a character offset and no document — which is exactly backwards, because the
reason the file is open is that something is wrong with it.

`lib/json/tolerant.ts` parses what it can and records the rest. Two kinds:

- **error** — something was skipped or guessed: a missing value, a stray
  token, an unclosed bracket, a truncated file.
- **lenient** — not JSON, but unambiguous: a comment, a trailing comma, a
  single-quoted string, an unquoted key, `NaN`. Every one of those is in real
  files, and refusing to open a document over one helps nobody.

Each problem carries its **line, column and path** (`$.rows[1].email`), the
row is marked in the tree, and the list jumps to it. Recovery is per member:
one bad entry costs one entry, not the rest of the file. **Repair** writes the
document back out as valid JSON from what was understood.

It is a state machine with an explicit stack, not recursive descent — the
first version was recursive, and a 50,000-deep document proved it by
overflowing the stack in the test that now guards it.

## 6. A gigabyte

A gigabyte cannot go through the webview: as a JavaScript string it is two
gigabytes of UTF-16 before parsing, and `JSON.parse` allocates the objects on
top. So the scan happens in Rust — `crates/core/src/bigjson.rs` — over the
bytes, into the same flat index of fixed-size 32-byte records. No
`serde_json::Value`, no allocation per node, tolerant in the same way and with
the same two classes of problem.

Measured on this machine, release build:

| | |
|---|---|
| **1.07 GB, 57.6M nodes** | indexed in **1,021 ms** |
| 3.3 MB, 250k nodes | 24 ms (debug build) |

The honest constraint is memory, not time: the index is 32 bytes a node, so a
document of many small values costs more in index than in file. The gigabyte
above averages 19 bytes a node, so its index is **1.84 GB — 172% of the
file**. A file of larger values costs proportionally less. Anything opened
this way should say what it will need before it starts.

Depth is a `u16` and **saturates** rather than wrapping; a test at 200,000
levels pins that, because the first version wrapped silently.

## 7. TODO

- [x] Flat index, virtualised rows, scoped search, paths, format/minify
- [x] Six ways in, including one that needs no connection and one that
      enlarges over the table rather than navigating away from it
- [x] One viewer at every size — the old inspector tree is gone
- [ ] **Editing in the tree.** Today editing means editing the raw text and
      switching back. Per-value editing needs the same write path the grid
      uses (staged change → preview → commit), and is worth doing properly
      rather than as a text box that writes on blur
- [ ] **A query line** — JSONPath first, since that is what editors settled on
- [ ] Table mode for arrays of uniform objects, which is most API payloads
- [ ] JSON Schema validation, and diff against another document
- [x] Tolerant parsing: opens invalid JSON, marks every problem with its line,
      column and path, and repairs on request
- [x] Rust indexer for gigabyte files — measured at 1.07 GB in 1.02 s
- [ ] **Wire the Rust indexer to the window.** It is tested and measured but
      nothing calls it yet: it needs `json_open_file` / `json_rows` /
      `json_search` commands, and the viewer's data source abstracted so rows
      can arrive asynchronously instead of from a local array
- [ ] Warn before opening a file whose index will not fit in memory
