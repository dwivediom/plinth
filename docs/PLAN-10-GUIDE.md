# Plan 10 — The Guide

## 0. The problem

Everything built in plans 5–9 is discoverable only by someone who already
knows it is there. There is no page that says what this app does, no answer
to "how do I…", and nothing that states — in one place, checkably — how it
differs from the client the person is coming from.

A menu of help topics does not solve this. The two questions people actually
have are **"what is in here"** and **"how do I do X"**, and the second one is
a search box.

## 1. Where it lives

The `i` in the sidebar's switcher row, beside search / databases /
connections, and the first button on the launcher, where a new person starts
before any connection exists. `⌘⇧/` anywhere, and "Guide & Features" in `⌘P`.
It opens as a full-window overlay, so it is a place rather than a dialog.

## 2. Three parts

**The search.** Twenty-seven tasks, each phrased as the question a person
would ask, each answered in numbered steps with its shortcut. Matching is
token-based over the question, its synonyms and its steps. **Where the app can
simply do the thing, the answer carries a button that does it** — Do it on
"see how my tables are connected" opens the map and closes the guide. ↑ ↓
move, ↵ runs, Escape clears the search before it closes the page.

**The tour.** Eight sections, one per capability, each with three points and a
drawing. Every task is linked from the section it belongs to, so the page and
the search are one index seen two ways.

**The comparison, and the honest half.** A capability-by-capability table
against TablePlus, DBeaver CE and DataGrip, where every mark carries the note
that qualifies it, followed by *What it does not do yet*. A tour that only
lists wins is an advertisement.

## 3. The drawings

Eight SVGs, hand-built, in the app's own materials: `--content` surfaces,
hairline separators, the `--syn-*` syntax palette the editor uses, the
`--series-*` chart colours, the `--heat-*` plan ramp. They follow the theme
because they are made of the same variables, they stay sharp at any size, and
they add nothing to the bundle but markup.

Not screenshots: a screenshot goes stale, ships as a raster, is wrong in the
other appearance, and has to be retaken every time a pane changes.

Motion is one idea applied consistently — things arrive from just below, once,
when scrolled to. On top of that only what the picture is *about* keeps
moving: the confirmation types its table name, the foreign key flows along its
edge, the heat meters fill. `prefers-reduced-motion` turns all of it off and
the page renders in its arrived state.

## 4. Every claim, checked against the code

A guide that describes features the app does not have is worse than no guide.
Each line of the tour and each task was read against the implementation.

**True as written** — local model detection, install and a dropdown filtered
by usable memory; the step loop with Auto/Manual and Run/Skip; self-verify and
one retry; the MCP server's seven read-only tools; `EXPLAIN`/`EXPLAIN ANALYZE`
with the read-only gate and the seven hazard rules; the schema diff and its
commented-out destructive statements; five chart forms, the named-form guess
and the transparent PNG; `vector`/`halfvec`/`sparsevec` decoding with the
sparkline, dimension and norm, and similarity search from the row menu; the
editor's schema colouring, FK-aware JOIN completion, alias awareness, search,
multi-cursor and server-positioned error underline; staged grid edits with the
SQL preview; the console's per-source filter and the searchable history.

**Four claims were ahead of the code. All four are now built:**

| Claimed | Was | Now |
|---|---|---|
| "Nothing destructive happens by accident" | the confirmation existed **only for SQL the model wrote**; a `DELETE` typed in the editor ran on the spot | `lib/writeGate.ts` in front of every run — see PLAN-5 §1.1b |
| "Safe mode refuses writes outright" | a flag in the window that the editor never consulted | enforced on the engine's workspace — PLAN-5 §1.1c |
| "Click a table to isolate its neighbourhood" | only the filter box dimmed anything; clicking did nothing | click focuses a table and recedes everything outside its neighbourhood; click the canvas to clear |
| "Paths are copyable" (JSON) | the tree had no copy affordance at all | every row hands you the accessor for the driver you are on — `->>` on Postgres, `$.a.b` on MySQL, `json_extract` on SQLite |

One claim was **corrected rather than built**: pinning tables for the AI was
described as a sidebar action when it was only reachable by `@mention` in the
chat. The sidebar menu now has *Add to AI Context* as well, and the copy names
both routes.

## 5. TODO

- [x] `i` in the sidebar, a button on the launcher, `⌘⇧/`, and a palette entry
- [x] Task index with steps, shortcuts, and Do-it buttons that run the action
- [x] Eight tour sections, each linked to its tasks
- [x] Eight themed, animated drawings; both appearances checked
- [x] Comparison table with a qualifying note under every mark
- [x] "What it does not do yet"
- [ ] A first-run nudge to open it once, for a genuinely new install
- [ ] Deep links (`guide#explain`) so an empty state can point at its section

### Four things that bit

The tour and the results share one scroller, so a search made halfway down the
page landed **below** its own answers. The scroll resets on every change of
query.

Backticks in the copy rendered as backticks. The page now renders `code`
spans, which is also why the prose can say `WITH … DELETE` at all.

The guide's stylesheet defined a bare `.row` with 64px of padding — and the
data grid's rows are `.row` too. Every row in every table became 129px tall
while the virtualiser kept positioning them 26px apart, so one selected row
painted its highlight across five. Every selector in `guide.css` is now scoped
under `.guide`; a page-specific stylesheet with generic class names is a
loaded gun.

Writing the guide is what found the gaps. Describing a feature plainly enough
for a stranger is a test: three of the four holes above were invisible until a
sentence had to be true.
