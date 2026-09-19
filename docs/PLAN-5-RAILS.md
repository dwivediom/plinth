# Plan 5 — Production Rails, Editor Mechanics, Types

Five complaints drive this plan. Each was checked against what Plinth already
has and against what exists open source, because most of this is assembly, not
invention.

| # | The complaint | Verdict after checking |
|---|---|---|
| 1 | Nobody trusts a GUI against production — even a `SELECT` can wedge a table | Real. But the rails are `statement_timeout`, a read-only role and manual commit — *not* an LLM reading `EXPLAIN` |
| 2 | SQL editors feel 15 years behind VS Code | Half already shipped (`⌘P` exists). The rest is CodeMirror config, not a text engine |
| 3 | JSON and vectors render as blobs | JSON is mostly done. `vector` is a genuine hole — it decodes as text today |
| 4 | Multi-schema is clunky | Sidebar already groups by schema. "No prefix" is `search_path`. Drift is the real gap |
| 5 | Ghost connections, bloated clients | Pooling is already sane (sqlx defaults). Tunnel drops and missing timeouts are the real causes |

## 0. What we are not building

Checked before writing any code. Anything in this table that we re-implement
is a mistake, not a preference.

| Need | Use | Licence | Note |
|---|---|---|---|
| Ollama HTTP client | [`ollama-rs`](https://crates.io/crates/ollama-rs) 0.3 | MIT | Typed, async, streaming, tool calling. Replaces our raw `TcpStream` |
| SQL out of a model, reliably | Ollama structured outputs (`format` + JSON Schema) | — | Replaces fence-parsing prose and the `@table` convention |
| Markdown in chat | `react-markdown`, or `streamdown` for streaming | MIT | Only once answers stream |
| Find/replace, regex, multi-cursor | `@codemirror/search`, `EditorState.allowMultipleSelections`, `rectangularSelection` | MIT | Already have CodeMirror 6 |
| Minimap | [`@replit/codemirror-minimap`](https://github.com/replit/codemirror-minimap) | MIT | Low value in a 40-line query. Last |
| EXPLAIN plan visual + hazard rules | [`pev2`](https://github.com/dalibo/pev2) | PostgreSQL | Vue component — take its rules, or iframe its standalone HTML |
| "Would this index help?" | HypoPG + `index_advisor` | PostgreSQL | Hypothetical indexes, no disk cost. Needs the extension |
| Hazard checklist | pgMustard's public EXPLAIN glossary | docs only | Tool is commercial; the glossary is the spec |
| JSON tree editing | `vanilla-jsoneditor` | ISC | Only if per-key editing outgrows `JsonTree.tsx` |
| Vector ops | `pgvector` operators `<=>` `<->` `<#>` | PostgreSQL | Nothing to build but the SQL and the UI |
| Schema diff | Atlas / migra / Skeema | Apache-2 / others | **We already introspect both sides** — diff in-process, offer export. No Go or Python runtime inside a Tauri app |
| Manual-commit semantics | DBeaver's model | — | Copy it, including "smart commit" and *not* opening a transaction for `SELECT` |

Two findings worth keeping in front of us:

- **App-layer SQL parsing is not a security boundary.** Postgres MCP Pro validated
  every AST node in "restricted mode" and was still bypassed in production. Our
  `policy.rs` is a UX layer over the real rails: a read-only role, `statement_timeout`,
  and `default_transaction_read_only` (already set on read-only connections).
- **`EXPLAIN ANALYZE` executes the statement.** `policy.rs` already knows this.
  Pre-flight on production uses plain `EXPLAIN`, always.

## 1. Production rails

### 1.1 Session limits ⚠︎

Every network connection gets limits applied in `after_connect` — the hook the
Postgres driver already uses for read-only mode.

| Driver | Statement timeout | Idle-in-transaction |
|---|---|---|
| Postgres | `SET statement_timeout` | `SET idle_in_transaction_session_timeout` |
| MySQL | `SET SESSION max_execution_time` (SELECT only) | — |
| SQLite | — (local file) | — |

Stored per profile as `statement_timeout_ms`. Default by environment:
production 30 s, staging 60 s, local off. `idle_in_transaction_session_timeout`
waits for Prod Mode — setting it now would kill the manual-commit transaction
§1.3 is about to introduce. A person can override it, including
back to off, per connection — a 20-minute analytical query is legitimate.

### 1.1b The write gate — one dialog, every path

The policy engine decides what is *allowed*. The gate decides whether anyone
*looked*. Before this, it existed only for SQL the model proposed: a `DELETE`
typed into the editor went straight to the server, which is the one path
people actually use.

`lib/writeGate.ts` now stands in front of every run. It asks `sql_check` — the
same classifier the real run uses, so the answer cannot drift — and picks a
tier from the parse:

| Statement | What happens |
|---|---|
| read-only | nothing; it runs |
| `UPDATE` / `DELETE` with a `WHERE` | the statement is shown, Cancel or the verb |
| no `WHERE`, any DDL, or unparseable | the same, plus type the table's name |
| refused by policy or safe mode | no dialog — the run goes ahead and the engine's own error lands on the statement |

The dialog shows the exact text that will be sent, never a summary of it, and
the go-ahead button stays disabled until the typed name matches. For an
unbounded statement it also shows the table's row estimate, labelled as an
estimate.

### 1.1c Safe mode is enforced where it can be enforced

Safe mode used to be a flag in the window. The grid honoured it, the sidebar
honoured it, the AI pane honoured it — and the SQL editor did not, so the
padlock was decoration exactly where it mattered most.

It now lives on the engine's `Workspace` (`safe_mode: AtomicBool`), is set
through `workspace_set_safe_mode`, and is checked in `execute_one` and
`sql_check`. It defaults to on for production and for read-only connections,
so a workspace is never briefly writable between opening and the window
telling the engine what it remembers.

The connection's policy is consulted **first**, so the refusal names the
constraint that actually binds: telling someone to unlock a padlock when the
connection itself is read-only sends them to a switch that will not move.

### 1.1d The way out of a refusal

A rail you cannot get past without leaving the app is a rail people route
around permanently — they connect with `psql` and stop using the client for
anything that matters. So a policy refusal now carries the way through, and
which way depends on which wall it is:

| Refused by | The button | Why that one |
|---|---|---|
| Safe mode | **Unlock safe mode** | One toggle, already in the toolbar. It gates every write, so it comes first even when the policy would also refuse |
| A read-only connection | **Connection settings…** | Read-only is a promise about the connection, not a default to be talked out of. The change is deliberate, persistent and visible |
| read-write refusing DDL | **Run once anyway** | The common case: the connection is for writing, this one statement is DDL |

`query_run_elevated` runs a single statement as if the policy were `full`. It
is narrow on purpose:

- a **read-only connection cannot be elevated at all** — the engine refuses,
  not the window;
- **safe mode still applies**, because the padlock answers a different
  question from the policy and one click should not answer both;
- it lasts exactly one call and nothing is remembered;
- the console logs it as `-- policy elevated for one run`, so the audit shows
  who went around the policy and when;
- and it still meets the **write gate**, so DDL is typed out before it runs.
  Elevation removes the policy's objection, not the one that asks whether you
  meant it.

The way out travels with the refusal wherever it appears — the results row
under the editor, and the notice that comes back from **Create it** in the
optimiser. `state/overlays.ts` toasts carry an optional action for exactly
this: a notice that says what went wrong and leaves you to find the fix is
half a message. One function, `lib/policyWayOut.ts`, decides which way out it
is, so two places can never disagree about it.

### A bug the button found

`CREATE INDEX ON public.orders (status)` asked **"Type `ON` to confirm"**. The
table-name regex matched `INDEX` and took the next word, and the gate has been
asking for the wrong word for any index DDL since it was written. A
confirmation that asks for the wrong word is worse than no confirmation: it
teaches people to type whatever is in bold without reading it.

`tableFromSql` now knows the shapes — an index is built *on* a table, and the
name after `INDEX` is the index's own — and has fifteen cases pinned down,
including `DELETE a FROM accounts a JOIN batches b ON b.id = a.batch_id`,
where the naive reading of `ON` would have asked for `id`.

### 1.2 Pre-flight EXPLAIN

Before running against a **production** connection, run `EXPLAIN (FORMAT JSON)`
on a second connection and apply deterministic rules to the plan:

- `Seq Scan` where `Plan Rows` is above a threshold
- estimate vs actual off by >100× (only with a cached `ANALYZE`, never live)
- `Nested Loop` with large `loops`
- `Sort Method: external merge` (spilled to disk)
- no `Limit` above a large scan

Rules produce the warning; the local model only *phrases* it, and only if a
model is connected. A model must never be the thing that decides a query is
dangerous — it can hallucinate a clean bill of health.

### 1.3 Prod Mode (manual commit) ⚠︎

A per-workspace toggle, defaulted on for `environment == production`:

- `SELECT` never opens a transaction (DataGrip's DBE-10935 is people hating
  exactly that)
- the first write **implicitly opens** one and the status bar shows
  `N statements pending · Commit ⌘⏎ · Rollback`
- an open transaction **pins one pooled connection** for its life — this is the
  architectural part: our pool hands out any of four, so a transaction needs a
  checked-out connection owned by the tab
- closing a tab or the window with pending work asks first; a dropped
  connection rolls back and says so

## 2. Editor mechanics

`⌘P` Open Anything, `⌘K` databases, `⌘⇧K` connections already exist. What is
missing is text editing, and it is configuration:

- `EditorState.allowMultipleSelections.of(true)` + `rectangularSelection()` +
  `crosshairCursor()` — multi-cursor and column selection
- `@codemirror/search`: `search({ top: true })`, `searchKeymap`,
  `highlightSelectionMatches()` — find, replace, regex, `Mod+D` select-next
- **Chord collisions** ⚠︎: `⌘F` is Toggle Filter Bar and `⌘D` is Duplicate Row.
  Both are global and capture-phase. They need `when: () => !editorFocused()`,
  the guard `⌘I` already uses, so the editor wins while it has focus.
- the search panel needs Apple-native styling; CodeMirror's default is not.

## 3. Types: JSON and vector

### 3.1 `Unsupported` ⚠︎

`PLAN.md` specified `Value::Unsupported { type_name, raw }` and it was never
built — unknown types fall through to text. That is why a `vector(1536)` column
is a 20 KB string today. Build it first; vector support depends on it.

### 3.2 Vector

- `vector`, `halfvec`, `sparsevec` decode to a typed cell carrying dimension
  and the raw values
- the grid cell shows `vector(1536) · ‖v‖ 0.98` with a sparkline, not numbers
- the inspector shows the first/last values, dimension, and norm
- a similarity bar above the grid: pick a column, paste or pick a source row,
  choose cosine / L2 / inner product, and it generates
  `ORDER BY col <=> $1 LIMIT k` — the SQL goes through the normal editor path,
  so the policy engine and console see it like anything else

### 3.3 JSON

`JsonTree.tsx` already renders a collapsible tree; editing replaces the whole
document. Per-key editing generates a targeted `jsonb_set(col, '{a,b}', …)`
rather than rewriting the document, which matters when two people edit one row.

## 4. Schemas

- `search_path` per tab so `orders` resolves without `public.` ⚠︎ — same pooling
  constraint as transactions: any connection may serve the next query, so this
  is an `after_connect` default plus an explicit `SET` when a tab overrides it
- sidebar: schema › type grouping already exists; add the filter popover from
  PLAN-4 and a "system schemas" toggle
- **Drift** — built. `Driver::schema_snapshot()` reads a whole database's
  catalogue in four queries, `diff::compare` matches the two by name (so column
  *order* is never a difference, and `character varying(50)` is not a change
  from `varchar(50)`), and `diff::migration_sql` writes the `ALTER`s. Additive
  statements are runnable; anything that destroys data — a dropped column, a
  dropped table — is emitted **commented out** with the reason, as is a
  `NOT NULL` column with no default, which would fail on a non-empty table.
  Verified against two live Postgres databases with deliberate drift.
- Older note, for reference: render added/removed/changed columns, types, nullability,
  indexes and FKs. Export as SQL, or as an Atlas migration if `atlas` is on PATH

## 5. Stability and footprint

sqlx already defaults to `test_before_acquire: true`, `idle_timeout: 10 min`,
`max_lifetime: 30 min`; we override only `max_connections(4)` and
`acquire_timeout(10 s)`. So the real work is not pool tuning:

- the PLAN-2 `TunnelSupervisor` with pool invalidation on drop (unbuilt)
- session limits from §1.1, which is what actually kills a wedged query
- restore tab state and re-run nothing automatically after a reconnect
- memory budget: Tauri idles around 45 MB against Electron's ~170 MB, but our
  ceiling is the cursor ring buffers, not the webview. Track RSS with a large
  result set open in CI, not just at idle

## 6. Order of work

**P0 — cheap, high value** — done
- [x] `@codemirror/search` + multi-cursor + rectangular selection, with the
      `⌘F` / `⌘D` guards and a styled panel
- [x] Session limits (§1.1) with per-profile override and environment defaults.
      Postgres is covered by an integration test; the MySQL branch (with its
      MariaDB fallback) is written but untested — no server to hand
- [x] Ollama structured outputs replacing fence-parsing in the AI pane

**P1 — the safety story**
- [x] The write gate in front of every run — editor, AI, sidebar — with the
      type-the-table-name tier for unbounded statements and DDL
- [x] Safe mode enforced in the engine rather than the window, with its own
      refusal message and a policy-first attribution (tests in `policy.rs`)
- [x] A way out of every policy refusal — unlock, settings, or one elevated
      run — with the elevation refused outright on a read-only connection
- [ ] Prod Mode: pinned connection, pending count, Commit / Rollback
- [ ] Pre-flight `EXPLAIN` with deterministic rules; model phrases only
- [ ] `ollama-rs` + streaming answers

**P2 — types**
- [x] `vector` / `halfvec` / `sparsevec` as a first-class `LogicalType`, decoded
      from pgvector's **binary** wire format (sqlx has no type for it) —
      verified live against pgvector 0.8.6
- [x] Vector cells: sparkline fingerprint, dimensions, norm — never the digits
- [x] Similarity search from the row menu: generates the `<=>` query, anchored
      to the source row by key rather than 1,536 pasted literals
- [ ] `Value::Unsupported` for everything else unknown
- [ ] Inspector panel for a vector: min/max/mean and a larger sparkline
- [ ] Per-key JSON editing via `jsonb_set`

**P3 — the rest**
- [ ] `search_path` per tab; sidebar filter popover
- [ ] Schema drift viewer
- [ ] Minimap
