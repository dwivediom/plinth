# Plan 4 — Tabs, and Everything Else TablePlus Has That We Didn't

**Companion to PLAN.md, PLAN-2, PLAN-3.** Source: TablePlus's own UI — the annotated anatomy screenshot and the workspace screenshots you sent. No web research; everything here is read off the screen.

*Drafted 2026-09-17.*

---

## 1. Workspaces, windows, and tabs

TablePlus has **two levels** of tabs, and the difference is the whole navigation model:

```
┌ ● ● ●  toolbar ─────────────────────────────────────────────────────┐
│ prod-rds : app  │ prod-rds : analytics  │ staging-db : app          │  ← workspace tabs (native macOS window tabs)
├───────────────────────────────────────────────────────────────────────┤
│ ‹ ›  ▦ orders   ≣ select … from orders •   ★ orders by day   ＋      │  ← object tabs (ours)
├───────────────────────────────────────────────────────────────────────┤
```

A **workspace** is one connection + one database, with its own sidebar, object tabs, and console. Workspaces are tabbed in the window; object tabs live inside a workspace.

### Workspaces are native macOS window tabs

This is the Apple-native answer and it's also what TablePlus actually does — `Window › Move Tab to New Window` is the *system* menu item for NSWindow tabbing. Tauri exposes it: set `tabbingIdentifier` on the workspace window so macOS groups them. You get for free: the tab bar, `⌘⇧]` / `⌘⇧[` to cycle, `Window › Merge All Windows`, drag a tab out to make a window, `⌘N` for a new window — all with the OS's own behaviour and look. On Windows and Linux we draw the same strip ourselves.

### Built: one process, many windows

`⌘⌥N` (File → New Window, Window → New Window) opens one. A connection can be
opened straight into a new window from the launcher's row menu or with `⌘↵` in
either switcher, and the intent travels in the window's URL so it connects on
its own rather than showing the launcher first.

**Every connection opens in its own window.** One rule, no modifier to
remember: the launcher, the two switchers, `⌘P`, and saving a new connection
all go through `workspaces.launch()`, which either brings forward the window
that already holds it or opens a new one. The launcher stays what it is — the
place you manage connections and open the next one, as TablePlus's connection
list does — and a workspace window that spawned a new one returns to its own
work rather than sitting on the list.

That makes `open()` an internal primitive: a freshly created window uses it to
connect to the connection it was opened for, and `launch` falls back to it if
a window cannot be created at all. Nothing replaces a workspace in place any
more, so `replaceCurrent` is gone.

One engine, many windows. Connections, saved queries, the console and the AI
belong to the application; **a window owns the workspaces it has open**, and
that ownership is the part that needed building:

- Workspaces live in the engine and `workspace_list` returns all of them, so
  without ownership every window would adopt every connection. A shared
  `windows` key in the store maps window label → what it holds, and a window
  adopts only its own on boot. The main window also adopts anything a crashed
  window left claimed, so nothing is stranded.
- Opening a connection another window already holds **focuses that window**.
  Tab state is persisted per connection+database, so two windows on one
  database would overwrite each other's tabs.
- Closing a window hands its workspaces back (`onCloseRequested`, not
  `beforeunload` — the latter cannot tell a close from a `⌘R`).
- The title is `connection — database`, which is what `⌘\`` and Mission
  Control show when the title bar itself is hidden.
- `⌘W` closes a tab, `⇧⌘W` closes the window. The predefined Close Window item
  was dropped because macOS gives it `⌘W`, which is Close Tab here.

macOS window tabbing comes free from `tabbingIdentifier`: Window → Merge All
Windows, drag a tab out to make a window, `⌘⇧[` / `⌘⇧]` to cycle.

### Switching database, connection, or anything

Three switchers, matching TablePlus's shortcuts exactly so muscle memory carries over:

| Shortcut | Opens | Behaviour |
|---|---|---|
| **`⌘K`** | **Database switcher** — popover listing databases/schemas on this connection, searchable | `⏎` or double-click → **new workspace** (window tab). `⌥⏎` or right-click › *Open in Current Workspace* → replaces the current database in place. Right-click › *Open in New Window* |
| **`⌘⇧K`** | **Connection switcher** — same popover over connections | Same rules. `⌘N` then pick a connection = new window |
| **`⌘P`** | **Open Anything** — the command palette | Tables, views, queries, connections, databases, commands. `⏎` opens; `⌘⏎` opens in a new tab; typing a database name and `⏎` opens a new workspace |

The three live as a small icon group at the top of the sidebar, to the right of the traffic lights: `◎` Open Anything · `🛢` Databases · `⇄` Connections. That row is where TablePlus puts them and it's where the hand goes.

`⌘K` was our palette; it's now the database switcher and the palette moves to `⌘P`. Earlier plans are updated.

### Object tabs — the exact open rules

When you open a table, view, function, or query inside a workspace:

1. **Current tab unmodified → the new object replaces it** in the same tab (the preview-tab behaviour; title is italic while it's replaceable).
2. **Current tab modified** (pending grid edits, edited query text) → **it gets pinned** and the new object opens in a **new tab**. Nothing is ever lost by clicking around.
3. **Double-click** an object → opens *and pins* immediately.
4. Right-click › **Open in New Tab** → new tab regardless of the current one's state. `⌘⏎` in sidebar search does the same.
5. Opening an object that's **already open** in a pinned tab → switches to that tab rather than opening a duplicate.

### Tab kinds

| Kind | Opens from | Title | Icon |
|---|---|---|---|
| **Table / view / function** | Sidebar click, `⌘P`, FK link | `orders` | ▦ ⊞ ƒ |
| **Query** | `⌘T`, toolbar SQL button | Auto-titled from the first statement until renamed | ≣ |
| **Saved query** | Sidebar › Queries pane | The saved name | ★ |

Table tabs contain the `Data | Structure` switcher; Structure is not a separate tab.

### Tab bar anatomy

```
 ‹ ›   ▦ orders   ≣ select … from orders •   ★ orders by day   ⊞ v_daily_revenue   ＋           ⧉  ≡
```

- **`‹ ›` back / forward** — per-workspace navigation history, `⌘[` / `⌘]`, also in the `Navigate` menu.
- **`•` unsaved dot** replaces the close `×` until hover, the macOS convention.
- **Environment dot** before the title when the connection is production/staging.
- **`＋`** new query tab. **`⧉`** split. **`≡`** Show All Tabs (`⌘⇧\`) — searchable when the bar overflows.

### Tab context menu

Right-click any tab: **Rename Tab…** · **Close Tab** · **Close Other Tabs** · **Close Tabs to the Right** · **Pin / Unpin** · **Move Tab to New Window** (object tab → its own workspace window) · **Copy Table Name** / **Copy Query**.

Right-click any sidebar object: **Open** · **Open in New Tab** · **Open in New Window** · **Add to Favorites** · **Copy Name** · **Show DDL** · **Truncate…** / **Drop…** (guarded by policy).

### Keyboard

| Action | Shortcut |
|---|---|
| New query tab | `⌘T` |
| Close tab | `⌘W` — prompts on unsaved query text; pending grid edits prompt `Revert / Save / Cancel` |
| Reopen closed tab | `⌘⇧T` |
| Jump to tab 1–9 | `⌘1`…`⌘9` (`⌘9` = last) |
| Next / previous tab | `⌃Tab` / `⌃⇧Tab` |
| Next / previous **workspace** | `⌘⇧]` / `⌘⇧[` (native) |
| Move tab | `⌘⌥→` / `⌘⌥←` |
| Split right | `⌘\` |
| Rename query tab | double-click the title, or `⌘⇧R` |
| Back / forward | `⌘[` / `⌘]` |
| Show all tabs | `⌘⇧\` |
| New window | `⌘N` |
| Database switcher / connection switcher / Open Anything | `⌘K` / `⌘⇧K` / `⌘P` |

Tabs drag to reorder, drag out to a new window, and drag between workspaces of the same connection.

### Split view

`⌘\` splits the content area into two panes side by side, each with its own tab strip. Two panes maximum — a database client isn't an IDE. Focus follows the click; `⌃⌘→` / `⌃⌘←` moves focus between panes (`⌘⌥←→` is taken by moving tabs).

Inside a query tab, editor and results split vertically with a draggable divider (default 40/60); `⌘⇧E` collapses the editor to give results the whole pane.

### Restore

Every workspace and tab is persisted to local SQLite as you go: windows, workspace order, per tab — kind, title, pinned/preview, editor text and cursor, filters, sort, scroll, selected row, split layout. On relaunch, or reconnect after a tunnel drop, everything comes back. **Unsaved query text is never lost**: drafts auto-save every keystroke (500ms debounce).

### Saved queries

- `⌘S` on a query tab: first time asks for a name; after that saves silently. Tab icon becomes ★.
- Saved queries live in the sidebar **Queries** pane, grouped by folder, searchable with the same field as tables. Stored per connection; can be marked **shared across connections**.
- Each is also a plain `.sql` file in `~/Library/Application Support/<app>/queries/<connection>/`, watched by the app — greppable, backup-able, git-able.
- Query tabs auto-title from their first statement so unsaved tabs are tellable apart.

---

## 2. The rest of TablePlus, read off the screen

Walking the anatomy screenshot region by region. **Status** is against our current plans: ✓ already specified · **＋ add** · ◐ partly there, upgrade · — skip on purpose.

### Menu bar — `TablePlus · File · Edit · Connection · Plugins · Navigate · View · Window · Help`

| Feature | Status | Decision |
|---|---|---|
| Full native menu bar | ✓ | PLAN-3 §1.10 |
| `Connection` menu (new, edit, duplicate, reconnect, disconnect, switch database) | ＋ | Add as a top-level menu; it's where Mac users look |
| `Navigate` menu (back, forward, next/prev tab, go to table…) | ＋ | Add, wired to the tab/history model above |
| `Plugins` menu | — | Not v1. See §3. |

### Toolbar — left group

| Item (as seen) | What it does | Status | Decision |
|---|---|---|---|
| Sidebar toggle | Show/hide left sidebar | ✓ | `⌘⌥S` |
| ◎ target icon | **Open Anything** (`⌘P`) — jump to any table, query, connection | ✓ | Our palette is now `⌘P`; `⌘K` is the database switcher, `⌘⇧K` connections (§1) |
| ⊗ | **Cancel running query** | ✓ | PLAN.md §8a — `⌘.`. Show it as a toolbar item that's only enabled while a query runs |
| 👁 eye | **Preview pending changes** as SQL before saving | ◐ | We had "SQL on hover". Upgrade: a popover from the save bar and a toolbar item showing the exact statements, with a `Copy` button |
| ≣↑ | **Commit / push pending changes** (`⌘S`) | ✓ | Our `Save ⌘S` |
| 🔒 lock | **Safe mode** — toggle read-only for this session | ◐ | We have the policy engine. Add the toolbar lock: click cycles `Read-only → Read/write` with a confirmation on production. Lock is *closed* on prod by default |
| 🛢 cylinder | **Switch database** within the connection | ✓ | `⌘K` switcher, §1 — opens a new workspace by default, `⌥⏎` replaces in place |
| `SQL` | New query tab | ✓ | `⌘T` |

### Toolbar — centre

| Item | What it does | Status | Decision |
|---|---|---|---|
| Colour tag (pink block) | **Connection colour** — set per connection, shows in title bar and tab | ◐ | We have environment dots. Add a free colour tag *as well*: environment gives meaning, colour gives recognition |
| `MySQL 8.0.12 │ TLS │ My testing connection : sakila : country` | Driver + version · **TLS indicator** · connection : database : table **breadcrumb** | ＋ | Put this in the window title area. Each breadcrumb segment is clickable (connection → launcher, database → switcher, table → sidebar reveal). TLS shows a lock glyph; SSM/SSH shows a tunnel glyph |
| Red banner `Database 'x' is disconnected! Tap to reconnect…` | Disconnect state | ◐ | We put it in the status bar. TablePlus is right that it should be *impossible to miss*. Do both: status bar detail, plus a `red`-tinted strip under the toolbar that is itself the reconnect button. It auto-hides when the supervisor reconnects |

### Toolbar — right group

| Item | What it does | Status | Decision |
|---|---|---|---|
| ⚠ badge | **Pending changes / warnings** count | ＋ | Badge on the save item: number of unsaved edits across *all* tabs. Click lists them |
| ↻ | **Reload** current tab (`⌘R`) | ＋ | Re-runs the query or re-fetches the table; also refreshes the schema index |
| ▥ bars | Table structure / columns toggle | ◐ | Covered by the `Data │ Structure` switcher |
| `⌘` | **Keyboard shortcuts cheat sheet** | ＋ | A sheet listing every shortcut, searchable. Cheap and users love it. `⌘/` |
| ▭ bottom panel | **Console log** toggle | ＋ | See Console below. `⌘⇧C` |
| ▯ right panel | **Inspector** toggle | ✓ | `⌘I` |

### Left sidebar

| Feature | Status | Decision |
|---|---|---|
| `Items · Queries · History` switcher | ✓ | PLAN-3 §5.2 (we say `Tables`; rename to `Items` since it also lists views, functions, sequences) |
| Search for item | ✓ | PLAN-3 §5.2a |
| Tree grouped by type: `Functions`, `Tables`, (Views, Sequences, Types…) | ◐ | We grouped by schema. Do **schema › type**: `public › Tables / Views / Functions`. Collapsible, remembers state |
| Filter icon (show/hide types, system schemas) | ＋ | Popover: checkboxes per object type + "Show system schemas" |
| `＋ ⌄` at the bottom | New table / view / function / query | ＋ | Menu button. New table opens a Structure tab in create mode |
| Favourites | ✓ | Star in context menu; group pinned at top |
| History pane | ＋ | Every executed statement with time, duration, rows, status. Click reinserts into a query tab. Searchable. Persisted per connection |

### Table data view — bottom bar

`Data │ Structure` · `＋ Row` · `1 of 109 rows selected` · `Columns` · `Filters` · `‹ ⚙ ›`

| Feature | Status | Decision |
|---|---|---|
| `Data │ Structure` segmented | ✓ | Ours is in the toolbar; TablePlus puts it bottom-left. Keep ours in the toolbar — it's the Apple placement — but it's the same control |
| `＋ Row` | Insert a new row inline, at the top, with defaults pre-filled | ＋ | `⌘N` inside a table tab. Also `Duplicate row` `⌘D` |
| Selection count `1 of 109 rows selected` | ＋ | In the status bar; click to select all / none |
| `Columns` | Show / hide / reorder columns | ＋ | Popover with checkboxes and drag handles; persisted per table. Also `freeze` first N columns |
| `Filters` | Toggle the filter bar | ✓ | `⌘F` |
| `‹ ›` paging + `⚙` | Page through results; set page size | ◐ | We chose infinite scroll via cursors. Keep that, but add the `⚙` for page size / limit and a `Go to row №` |

### Right sidebar — `Details │ Assistant`

| Feature | Status | Decision |
|---|---|---|
| `Details`: selected row as an editable form, one field per line with its type | ✓ | Inspector row-as-form. Add the per-field type label |
| `Search for field…` | ＋ | Filter the form by field name — matters on 80-column tables |
| Field-level editors (JSON tree, long text, date picker, enum dropdown) | ＋ | Inspector fields open the right editor by type. This is where JSON columns get a proper tree |
| `Assistant` | ◐ | Our **AI Activity** panel + MCP. Rename the tab `AI`. See §3 |

### Console log — bottom panel

Every SQL statement the app itself runs, timestamped, with duration, and a filter (`All queries ▾`).

| Feature | Status | Decision |
|---|---|---|
| Console log | ＋ | **Add.** It's how you learn what the tool does behind your back, and it's our audit log's human face. One panel, two sources: `App` (introspection, edits) and `AI` (MCP calls). Filter by source, copy any line, click to open in a query tab |

### Query editor bar

`line 1, column 1` · `No limit ▾` · `Beautify ⌘I ▾` · `Run Current ▾`

| Feature | Status | Decision |
|---|---|---|
| Cursor position | ＋ | Status bar, right side |
| **Limit selector** `No limit / 100 / 1000 / custom` | ＋ | Per tab, default 1000, shown in the timing line. MCP keeps its own hard cap |
| **Beautify** `⌘I` | ＋ | Format SQL with a dialect-aware formatter; a `▾` for options (case, indent) |
| **Run Current ▾** — current statement / selection / all | ✓ | `⌘⏎` / `⌘⇧⏎`; add `Run Selected` when text is selected |
| Multiple result sets from one run | ＋ | Tabs inside the results pane, one per statement |
| Explain / Analyze | ＋ | `Explain ▾` next to Run: plain, analyze, and a tree visualisation for Postgres |

---

## 3. Features TablePlus has that aren't visible in a screenshot — and where we stand

| Feature | Decision |
|---|---|
| **Plugins (JS API)** | Not v1. When we do it, it's MCP-shaped: a plugin is a local MCP server the app loads, so plugins and AI share one extension surface. That's a better story than a bespoke JS API |
| **Import CSV / JSON / SQL** into a table | Phase 4 — streaming, with a column-mapping sheet and a preview of the first 20 rows |
| **Export** table or result to CSV / JSON / SQL inserts / Excel | Phase 2 has CSV/JSON to disk; add SQL inserts and `.xlsx` |
| **Backup / restore** (`pg_dump` / `mysqldump`) | Phase 4 — shell out to the tools if present on PATH, with a progress sheet |
| **Copy rows as** CSV / JSON / SQL insert / Markdown table | ＋ Phase 2 — `⌘C` copies TSV; `⌘⇧C` opens the "copy as" menu |
| **Paste rows** from clipboard / spreadsheet | ＋ Phase 4 |
| **Foreign-key navigation** — click a FK value, jump to the referenced row | ＋ Phase 2 — this is a genuinely great TablePlus feature and it's cheap once you have the schema index |
| **Multi-cursor editing** in the SQL editor | ✓ Free with Monaco |
| **Autocomplete** with schema awareness | ✓ Phase 2 |
| **Snippets** | ＋ Phase 4 — user-defined, `Preferences › Editor` |
| **Structure editing via UI** — add/edit/drop columns, indexes, FKs, and see the DDL before applying | ＋ Phase 4 — Structure tab in edit mode: changes accumulate, `Preview` shows the `ALTER` statements, `Save` runs them in a transaction where the driver supports transactional DDL (Postgres yes, MySQL no — warn) |
| **Show create / DDL viewer** | ＋ Phase 2 — read-only DDL at the bottom of the Structure tab, `Copy` button |
| **Connection groups / tags / colours** | ◐ — folders in the launcher exist; add colour tags (above) |
| **Import connection from URL** (`postgres://…`) | ＋ Phase 2 — paste a URL into the connection sheet and it fills the fields |
| **Duplicate connection** | ＋ Phase 2 |
| **Keep-alive** | ✓ The tunnel supervisor's `SELECT 1` doubles as this |
| **iCloud / encrypted sync of connections** | Later — export an encrypted bundle first; sync is a v2 problem |
| **Dark mode** | ✓ |
| **iOS app** | — |
| **Redis / Mongo modes** | ✓ Phase 4 |
| **ER diagram** | Not v1 — but the schema index makes it a weekend once the rest exists |

**Assistant vs our AI.** TablePlus's `Assistant` tab is a chat box. Ours is inverted — the MCP server lets Claude drive the app from outside — but there's no reason not to *also* have the panel: an `AI` tab in the inspector that shows the activity log **and** a small prompt field that sends to whichever MCP client is connected. Same engine, same guardrails, same audit log.

---

## 4. Priority — what to pull forward

Of everything above, five things change how the app *feels* and should move into Phase 2, not Phase 4:

1. **Tab restore with never-lost drafts** — it's what makes people trust a tool with their work
2. **Console log** — transparency, and the AI audit log for free
3. **Foreign-key navigation** — the one TablePlus feature people mention unprompted
4. **Switch-database popover + breadcrumb** — without it, multi-database servers are painful
5. **Reconnect strip + safe-mode lock in the toolbar** — the two states a user must never be unsure about

Everything else stays where the roadmap has it.
