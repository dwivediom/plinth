# Plan 3 — Design: Apple-Native

**Companion to PLAN.md and PLAN-2.** The design schema lives in `design/tokens.json` (source of truth) and `design/tokens.css` (what the app imports). `design/preview.html` renders both appearances from the tokens.

*Revised 2026-09-17 — Apple HIG–inspired.*

---

## 0. The brief

**It should feel like Apple shipped it.** Not "inspired by" in the sense of borrowing a blue — in the sense that someone who lives in Finder, Mail, and Xcode opens this app and their hands already know where everything is.

That's what TablePlus gets right and every Electron client gets wrong. And it's why the design system here is not invented: it's the macOS Human Interface Guidelines, applied to a database client. When in doubt, the answer is "what would Finder do."

On Windows and Linux the same tokens degrade gracefully — no vibrancy, fixed accent, native title bar — and it still looks like a calm, well-made tool.

---

## 1. The ten things that make it feel native

1. **System font.** SF Pro via `-apple-system`. 13px body, 11px secondary. Never a web font for UI.
2. **The user's accent colour, not yours.** macOS lets people pick blue, purple, pink, red, orange, yellow, green, or graphite. WebKit exposes it as the CSS `AccentColor` system colour. Use it. Selection, focus rings, and the default button all follow the user's choice — that alone makes it feel like *their* Mac.
3. **Unified toolbar in the title bar.** Traffic lights top-left, toolbar items on the same row, no separate title bar strip. Tauri: `titleBarStyle: "Overlay"`, `hiddenTitle: true`.
4. **Full-height translucent sidebar.** The sidebar runs from the top of the window to the bottom, behind the traffic lights, with vibrancy so the desktop bleeds through faintly. Tauri: the `window-vibrancy` crate with `NSVisualEffectMaterial::Sidebar`; CSS `backdrop-filter` as the visual layer.
5. **Source-list selection.** Sidebar selection is a rounded (6px) accent-filled row with white text when the window is focused, and a grey row when it isn't. Exactly like Finder.
6. **Sheets, not modals.** The connection form slides down from the title bar as a sheet attached to the window. Popovers have an arrow pointing at what opened them.
7. **Segmented controls for view switching.** `Data · Structure · Query` in the toolbar as one segmented control, not three tabs.
8. **Label hierarchy by opacity.** Apple's four label levels — primary, secondary, tertiary, quaternary — are the *same colour at different opacities*. This is why Apple UIs look cohesive: there is only one text colour.
9. **Hairline separators.** `rgba(0,0,0,0.1)` light, `rgba(255,255,255,0.1)` dark. Never a solid grey border.
10. **A real menu bar.** File, Edit, View, Connection, Query, Window, Help — every command lives there with its ⌘ shortcut, because that is where Mac users look first. The `⌘P` Open Anything palette is a complement, not a substitute.

---

## 2. Colour

Apple's system colours, not custom ones. They're tuned for both appearances and for the vibrancy materials, and users already associate them with meaning.

### Backgrounds

| Token | Light | Dark | macOS name |
|---|---|---|---|
| `window` | `#ECECEC` | `#323232` | windowBackgroundColor |
| `content` | `#FFFFFF` | `#1E1E1E` | controlBackgroundColor / textBackgroundColor |
| `sidebar` | `rgba(236,236,236,0.80)` + blur | `rgba(40,40,40,0.80)` + blur | Sidebar vibrancy material |
| `alt-row` | `rgba(0,0,0,0.03)` | `rgba(255,255,255,0.04)` | alternatingContentBackgroundColors |
| `control` | `#FFFFFF` | `rgba(255,255,255,0.10)` | Push button / field fill |
| `popover` | `rgba(246,246,246,0.92)` + blur | `rgba(46,46,46,0.92)` + blur | Popover / menu material |
| `separator` | `rgba(0,0,0,0.10)` | `rgba(255,255,255,0.10)` | separatorColor |
| `grid` | `rgba(0,0,0,0.08)` | `rgba(255,255,255,0.08)` | gridColor |

### Labels — one colour, four opacities

| Token | Light | Dark |
|---|---|---|
| `label` | `rgba(0,0,0,0.85)` | `rgba(255,255,255,0.85)` |
| `label-2` | `rgba(0,0,0,0.50)` | `rgba(255,255,255,0.55)` |
| `label-3` | `rgba(0,0,0,0.26)` | `rgba(255,255,255,0.25)` |
| `label-4` | `rgba(0,0,0,0.10)` | `rgba(255,255,255,0.10)` |

### Accent and semantics

| Token | Light | Dark | Notes |
|---|---|---|---|
| `accent` | `AccentColor` → `#007AFF` | `AccentColor` → `#0A84FF` | **System accent** with systemBlue fallback |
| `accent-text` | `AccentColorText` → `#FFFFFF` | same | Text on accent |
| `selection-unfocused` | `#DCDCDC` | `#464646` | unemphasizedSelectedContentBackground |
| `green` | `#28CD41` | `#32D74B` | systemGreen |
| `orange` | `#FF9500` | `#FF9F0A` | systemOrange |
| `red` | `#FF3B30` | `#FF453A` | systemRed |
| `yellow` | `#FFCC00` | `#FFD60A` | systemYellow |
| `gray` | `#8E8E93` | `#98989D` | systemGray |

### Where colour appears — the complete list

- **Selection** — `accent` fill, `accent-text` text (focused); `selection-unfocused` when the window is inactive
- **Focus ring** — 3.5px soft glow, `accent` at 50%. The macOS ring, not a hard outline.
- **Default button** — `accent` fill. One per sheet or view.
- **Sidebar icons** — `accent`, like Finder's Favorites
- **NULL** — `label-3`, italic
- **Dirty cell** — `yellow` at 18% fill (Apple's "unsaved" is yellow, cf. Notes and TextEdit)
- **Environment** — a 3px dot beside the connection name and in the window title: `red` production, `orange` staging, none local
- **Tunnel status** — 7px dot: `green` / `orange` / `red`, with the macOS status-dot gloss (inner highlight)
- **Syntax** — keywords `accent`, strings `red` (Xcode's convention), numbers `accent` at 80%, comments `label-3`
- **Errors** — `red` text inline; never a red banner

---

## 3. Typography — Apple's text styles

Use the macOS text-style scale by name. It's what every native app uses, so it's what feels right at a glance.

| Style | Size / Line | Weight | Use |
|---|---|---|---|
| `large-title` | 26 / 32 | 700 | Launcher heading only |
| `title-1` | 22 / 26 | 400 | Sheet titles |
| `title-2` | 17 / 22 | 400 | Section headings in Settings |
| `title-3` | 15 / 20 | 600 | Panel headings, inspector titles |
| `headline` | 13 / 16 | 600 | Column headers, group labels |
| `body` | 13 / 16 | 400 | Everything |
| `callout` | 12 / 15 | 400 | Sidebar rows, status bar |
| `subheadline` | 11 / 14 | 400 | Column types, metadata |
| `caption` | 10 / 13 | 400 | Timestamps, keyboard hints |
| `mono` | 12 / 20 | 400 | `ui-monospace` — SF Mono on Mac, bundled JetBrains Mono elsewhere |

- **`font-variant-numeric: tabular-nums` on every numeric cell.**
- Sidebar group headers: `subheadline`, 600, `label-2`, uppercase — Finder's `Favorites`.
- Letter-spacing is never adjusted. SF is already optically corrected per size.

---

## 4. Shape, depth, motion

**Radii (Sequoia-era):** `6px` buttons, fields, segmented controls, sidebar selection · `10px` popovers and menus · `12px` sheets and windows · `999` pills.

**Controls:**
- Push button: 22px tall regular size, `control` fill, hairline border `label-4`, shadow `0 0.5px 1px rgba(0,0,0,0.15)`. Default button is `accent`-filled. Text 13px.
- Text field: 22px, `content` fill, hairline border, 6px radius, macOS focus glow.
- Search field: same, pill-ish 6px radius, magnifier glyph in `label-3`, clear button on input.
- Segmented control: 22px, grouped, selected segment raised with `content` fill and a hairline shadow.
- Checkbox / radio / switch: native `<input>` with `accent-color: var(--accent)` — WebKit renders real macOS controls.

**Depth:** sheets and popovers cast `0 8px 40px rgba(0,0,0,0.25)` and sit on the blurred material. Nothing else has a shadow.

**Motion:** Apple's default `200ms cubic-bezier(0.25, 0.1, 0.25, 1)` for sheets and popovers; `150ms` for selection and hover. Sheets slide down from the title bar. Nothing animates on launch.

**Window:** minimum 900×560. Sidebar 220px default, 180–320 drag range, collapsible with `⌘⌥S` and via the toolbar sidebar button. Sidebar state and window frame restore on relaunch.

---

## 5. Screens

### 5.1 Launcher — the connections window

Two panes, the TablePlus layout, because it is the right one: the window *is* the launcher (no card inside a window), the traffic lights sit over the brand pane.

```
┌ ● ● ● ───────────┬──────────────────────────────────────────────┐
│                  │  ＋  ⌕ Search for connection…                │
│      ▭           │  Pg  ddd                              ● prod │
│    Plinth        │      mvp-postgres-db….rds.amazonaws.com : app│
│  Version 0.1.0   │  Sl  analytics.db                            │
│  Open source     │      ~/data/analytics.db                     │
│                  │  PRODUCTION                                  │
│ [Backup Database]│  Pg  prod-rds                                │
│ [Restore Databas]│      …                                       │
│ [Create Connecti]│                                              │
└──────────────────┴──────────────────────────────────────────────┘
```

- **Brand pane** (300px, sidebar material): app mark, name, version, licence line; `Backup Database` / `Restore Database` / `Create Connection` as 44px buttons pinned to the bottom.
- **Connection list**: `＋` and a 32px search field; rows are 56px with a **driver badge** — a two-letter monogram in a fixed brand colour (`Pg` `Ms` `Ma` `Sl`) — name (+ environment dot) and a second line `host : database` or the SQLite path. Groups are headers. Double-click or `⏎` connects. Right-click: Open · Edit · Duplicate · Move to Group · Delete.
- **Create Connection** opens the **database picker** sheet: search + a 6-column grid of driver tiles (badge + label); unsupported backends are shown dimmed with a `Soon` tag so the roadmap is visible without lying. Footer: `Cancel · Import Connection · New Group · Create`.
- **Import Connection** takes a URL (`postgres://user:pass@host:5432/db?sslmode=require`, `mysql://…`, or a SQLite path), fills the form, carries the password to the keychain field, and guesses the environment from the host (`rds.amazonaws` → production).
- The connection sheet then has `Test · Cancel · Save · Connect`.

### 5.2 Workspace — the document window

```
┌ ● ● ●  ▤ │ [Data|Structure|Query]  ⌕ Filter tables…      ⓘ ┐
│ sidebar  │                                                   │
│ (vibrant)│                    content                        │
│ FAVORITES│                                                   │
│  ★ orders│                                                   │
│ PUBLIC   │                                                   │
│  ▦ orders│                                                   │
│  ▦ users │                                                   │
│          ├───────────────────────────────────────────────────┤
│          │ ● prod-rds · SSM · 1h 12m        ~4.2M rows       │
└──────────┴───────────────────────────────────────────────────┘
```

- Sidebar is full-height and translucent; traffic lights sit inside it. Group headers in `label-2` uppercase. Table icons in `accent`. Selected row is a 6px-radius accent pill.
- **Switcher icons** on the traffic-light row, right-aligned: `◎` Open Anything `⌘P` · `🛢` Databases `⌘K` · `⇄` Connections `⌘⇧K`. Monochrome `label-2` glyphs, 22px hit targets. This is where TablePlus puts them; see PLAN-4 §1.
- **Workspace tabs** (one per connection : database) are native macOS window tabs, drawn by the OS directly under the toolbar. Object tabs sit beneath them.
- **Sidebar header, top to bottom:** a compact segmented switcher `Tables | Queries | History` (20px, the TablePlus pattern — it's good and users already know it), then a **search field** — this is the one for finding tables. See 5.2a.
- Toolbar (in the title bar): sidebar toggle · segmented `Data | Structure | Query` · **`Filter rows`** field (data only — never tables) · inspector toggle. Items are SF-Symbol-style monochrome glyphs in `label-2`.

### 5.2a Sidebar search — finding tables

The most-used control in a DB client after the query editor. It must be always visible, never behind a shortcut alone.

```
┌ Tables │ Queries │ History ┐
│ ⌕ Search tables      ⌘⇧O │
├───────────────────────────┤
│ PUBLIC                    │
│  ▦ payments        312k   │
│  ▦ payment_methods        │
│ BILLING                   │
│  ⊞ v_payouts_daily        │
│ COLUMNS                   │
│  ▤ orders.payment_id      │
└───────────────────────────┘
```

Behaviour:

- **Always visible** at the top of the sidebar, 22px, placeholder `Search tables`, right-aligned `⌘⇧O` hint (Xcode's Open Quickly) that disappears on focus. `Esc` clears and returns focus to the tree.
- **Filters live** as you type. Groups with no matches collapse away; matching groups stay open. Schema headers remain so you know *where* a hit lives.
- **Subsequence match, not just prefix** — `pmeth` finds `payment_methods`. Matched characters are shown in `600` weight, no highlight colour (the Spotlight convention).
- **Ranks:** exact name › prefix › word boundary › subsequence; then favourites, then recently opened, then row count.
- **Searches across all schemas** on the connection, not just the expanded one. Cross-schema hits show under their schema header.
- **Columns as a secondary group.** After tables, a `COLUMNS` group lists `table.column` matches in `callout` size with a `label-3` icon — because "which table has `payment_id`?" is the second most common question.
- **Keyboard only:** `↓` moves from the field into results, `↑↓` walk them, `⏎` opens, `⌘⏎` opens in a new tab, `⌥⏎` reveals in Structure view.
- **Empty state:** one line in `label-3`, centred: `No tables match "xyz"`.
- **Performance:** search the in-memory schema cache, never the database. Results must appear within a keystroke; if the cache is still loading, show a thin `<progress>` under the field.
- **Views, functions, materialized views** are included and distinguished by glyph. A `Tables ▾` popover on the group header lets you hide types you don't care about.
- `⌘P` (Open Anything) also finds tables — but the sidebar field is the primary path, and the palette delegates to the same index.
- Content is `content` white / `#1E1E1E`.
- Inspector slides in from the right as a 260px pane, like Finder's Preview.
- Status bar: `callout`, `label-2`, hairline separator above.

### 5.3 Data view

- Column headers: `headline`, 11px, `label-2`, with type in `subheadline` `label-3` beneath. Sort arrow `▲` in `label-2`.
- Rows 26px, alternating `alt-row` fill (NSTableView style), hairline horizontal grid lines only — no vertical lines.
- Row selection: full-width `accent` with `accent-text` when focused. `selection-unfocused` otherwise.
- Filter bar appears *below the toolbar* when `⌘F` is pressed, as a slide-down strip (like Safari's find bar), with chips.
- Editing: double-click a cell. Dirty cells tint `yellow`. A bottom bar appears with `2 unsaved changes` and `Revert` / `Save ⌘S` — Apple's verbs, not "Commit".
- Row count `~4,200,000` in the status bar; click for exact.

### 5.4 Query view

- Editor on top with SF Mono, results below, split with a native-feeling divider.
- `⌘⏎` runs the statement at the cursor; `⌘⇧⏎` runs all; `⌘.` cancels (Apple's universal cancel).
- Errors appear as a compact inline row between editor and results: `⊗ column "amout" does not exist — line 3` in `red`, with the token underlined in the editor.
- History is a popover from a toolbar clock glyph.

### 5.5 Connection sheet

A sheet, slid down from the title bar. Fields in a two-column form with right-aligned labels (Apple's preferences layout):

```
            Name  [prod-rds                     ]
     Environment  (•) Production  ( ) Staging  ( ) Local
          Driver  [PostgreSQL              ⌄]

            Host  [mydb.abc.us-east-1.rds.amazonaws.com]
            Port  [5432]
        Database  [app     ]
            User  [readonly]
        Password  [••••••••]   ☐ Use IAM token

  ▸ Tunnel   None · SSH · AWS SSM
  ▸ Advanced

                              Cancel   [Connect]
```

Default button bottom-right. `Test Connection` as a secondary button bottom-left with inline stage results. `Esc` cancels.

### 5.6 Open Anything — `⌘P`

Spotlight-style: a centred floating field on the popover material, results below. 6px radius, no title bar.

### 5.7 AI Activity

A list in the inspector. Each entry looks like a Console.app row: timestamp `caption`, tool name `headline`, SQL `mono` one line. Filter field at the top.

### 5.8 Settings — `⌘,`

A Preferences window with a toolbar of tabs: General · Editor · Connections · AI. Each tab is a right-aligned-label form. Under 20 options total.

---

## 6. States

| State | Treatment |
|---|---|
| Loading rows | Native `<progress>` bar in the status bar; rows fill in as they stream |
| Connecting | Status dot pulses `orange`; text "Connecting through SSM…" |
| Empty table | Centred `label-2` text "No Rows" with a `label-3` line beneath: "This table is empty." |
| No connections | Large SF-style glyph in `label-4`, "No Connections", "Press ⌘⇧K to add one." |
| Error | Inline `red` row; database message verbatim |
| Tunnel dropped | Dot `red`; content dims to 60%; status bar "Tunnel dropped — reconnecting (2)" |
| Read-only policy | Inline: "This connection is read-only." with a `Change…` link that opens the sheet |

---

## 7. Do / Don't

**Do**
- Use the user's system accent
- Put every command in the menu bar with its shortcut
- Use sheets for forms, popovers for transient info, the inspector for detail
- Keep one text colour with four opacities
- Use native `<input>` for checkboxes, radios, switches, selects — WebKit draws real controls

**Don't**
- Draw custom checkboxes or switches
- Use a solid grey border where a hairline separator belongs
- Add a title bar strip above the toolbar
- Use "Commit" / "Discard" where Apple would say "Save" / "Revert"
- Center a dialog in the screen — attach it to the window as a sheet
- Put a shadow on anything that isn't a sheet, popover, or menu

---

## 8. Platform notes

| | macOS | Windows | Linux |
|---|---|---|---|
| Accent | System via `AccentColor` | Fixed systemBlue | Fixed systemBlue |
| Sidebar | Vibrancy | Solid `window` | Solid `window` |
| Title bar | Overlay, traffic lights inset | Native, toolbar below | Native, toolbar below |
| Mono font | SF Mono via `ui-monospace` | Bundled JetBrains Mono | Bundled JetBrains Mono |
| Controls | WebKit native | Chromium native | WebKitGTK native |

Same tokens everywhere. The Mac gets the extra polish; the others get a clean, calm, correct app.
