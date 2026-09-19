# Building an Open-Source Database Client with a Built-In MCP Server

**Stack:** Tauri 2 + React
**Databases (v1):** PostgreSQL, MySQL/MariaDB, SQLite, MongoDB, Redis
**AI angle:** the app exposes its own MCP server so Claude can query your databases through it

*Plan drafted 2026-08-20. Crate versions verified against docs.rs on that date.*

---

## 1. The core idea

Most database GUIs treat AI as a feature bolted on the side — a chat box that writes SQL for you. The more interesting design inverts that: **the app is the connection manager, and the MCP server is a second front-end onto the same engine.**

You already do the hard work of storing credentials securely, pooling connections, introspecting schemas, and normalising result sets across five wire protocols. An MCP server is a thin adapter over that work. Claude gets your connections without ever seeing a password, because credentials never leave the Rust process.

```
                    ┌─────────────────────────────┐
                    │      React UI (webview)      │
                    └──────────────┬───────────────┘
                                   │ Tauri IPC
   Claude Desktop  ── stdio ──┐    │
   Claude Code     ── stdio ──┤    │
   Other clients   ── HTTP ───┤    │
                              ▼    ▼
                    ┌─────────────────────────────┐
                    │        Core Engine (Rust)    │
                    │  connections · pool · query  │
                    │  introspection · policy      │
                    └──────────────┬───────────────┘
                     ┌─────┬───────┼───────┬──────┐
                     ▼     ▼       ▼       ▼      ▼
                    PG   MySQL  SQLite  Mongo  Redis
```

Both the UI and the MCP server are clients of the same core. Neither can do something the other can't.

---

## 2. Crate choices

| Concern | Crate | Version (Aug 2026) | Notes |
|---|---|---|---|
| App shell | `tauri` | 2.11.5 | ~10MB binaries, system webview |
| SQL drivers | `sqlx` | 0.9.0 | Postgres + MySQL + SQLite in one API, pure Rust, async |
| MongoDB | `mongodb` | 3.8.0 | Official driver. **License caveat below.** |
| Redis | `redis` | 1.6.0 | Official-ish, mature, async via tokio |
| MCP server | `rmcp` | 3.1.3 | Official Rust SDK, `#[tool]` / `#[tool_router]` macros |
| Credentials | `keyring` | 4.1.6 | macOS Keychain, Windows Credential Manager, Linux Secret Service |
| SQL parsing | `sqlparser` | 0.62.0 | For the read-only guard and statement splitting |
| SSH tunnels | `russh` | 0.61.1 | Tokio-based SSH in Rust; needed for the bastion-host workflow |
| Local metadata | `rusqlite` or `sqlx` | — | Store connection profiles, query history, saved queries |

**The MongoDB license caveat is worth knowing before you start.** The MongoDB *server* is SSPL-licensed, but the Rust *driver* is Apache 2.0 — linking to it from an Apache/MIT/GPL project is fine. This matters because it's the single most common licensing worry people raise when building DB tooling, and in this case it's a non-issue.

**Why sqlx over separate drivers:** one `Row` abstraction across three databases means your result-grid code is written once. The tradeoff is you give up `tokio-postgres`'s slightly better raw throughput and some Postgres-specific features (LISTEN/NOTIFY, COPY streaming). For a GUI that's the right trade — you're never the bottleneck, the human is.

**Skip compile-time query checking.** sqlx's headline feature (`query!` macros validated against a live database at build time) is exactly wrong here. Your queries are user-supplied at runtime. Use the runtime `sqlx::query()` API throughout.

---

## 3. The driver abstraction

This is the decision that determines whether the project stays pleasant at month six. Get it right early.

```rust
#[async_trait]
pub trait Driver: Send + Sync {
    async fn connect(cfg: &ConnectionConfig) -> Result<Self> where Self: Sized;

    // Introspection — powers the sidebar tree and MCP schema tools
    async fn list_databases(&self) -> Result<Vec<DatabaseInfo>>;
    async fn list_schemas(&self, db: &str) -> Result<Vec<SchemaInfo>>;
    async fn list_tables(&self, schema: &Scope) -> Result<Vec<TableInfo>>;
    async fn describe_table(&self, t: &TableRef) -> Result<TableSchema>;

    // Data
    async fn query(&self, sql: &str, opts: QueryOpts) -> Result<ResultSet>;
    async fn stream_query(&self, sql: &str) -> Result<BoxStream<Row>>;

    // Capability flags — the UI greys out what a driver can't do
    fn capabilities(&self) -> Capabilities;
}
```

**The hard part is `ResultSet`.** Every one of these databases has a different type system, and the naive approach (stringify everything) destroys information you need — you can't tell `NULL` from the string `"NULL"`, you can't right-align numbers, you can't render a JSONB column as a collapsible tree.

Define a normalised value enum up front:

```rust
pub enum Value {
    Null,
    Bool(bool),
    Int(i64),
    Float(f64),
    Decimal(String),        // never f64 — precision loss is a correctness bug
    Text(String),
    Bytes(Vec<u8>),
    Json(serde_json::Value),
    Timestamp(DateTime<Utc>),
    Date(NaiveDate),
    Time(NaiveTime),
    Uuid(Uuid),
    Array(Vec<Value>),
    Document(BTreeMap<String, Value>),  // Mongo, and PG composite types
    Unsupported { type_name: String, raw: String },
}
```

That last variant is the pressure valve. Postgres alone has hundreds of types including user-defined ones; without an explicit escape hatch you will either panic or silently corrupt data the first time someone opens a table with a `tsvector` column. Render `Unsupported` as monospace grey text and move on.

**Mongo and Redis don't fit the table model, and pretending otherwise is a trap.** Give them their own UI modes: Mongo gets a document list with a JSON tree view and a query-builder for filter/projection/sort; Redis gets a key browser with per-type value editors (string, hash, list, set, zset, stream). Sharing the grid component across all five is a false economy — Beekeeper Studio and TablePlus both took a while to get this right.

---

## 4. Security model

This is where you can beat the commercial tools rather than match them, and it's the part worth over-engineering.

**Credentials never enter the webview.** The React layer works with connection *IDs*, never secrets. Passwords go into the OS keychain via `keyring`; connection profiles (host, port, user, database, tunnel config) go into a local SQLite file. The IPC boundary passes `connection_id: Uuid`, and the Rust side resolves it.

This matters more than it sounds. A webview is a browser. Any XSS in a rendered cell value — and you *will* render untrusted data from databases — becomes credential theft if secrets live in JS memory. Keep the blast radius in Rust.

**Tauri capability config.** Tauri 2's permission system is allowlist-based. Lock it down:
- No `shell:allow-execute`
- No filesystem access beyond an explicit app-data scope and a user-chosen export directory
- CSP with no `unsafe-inline`, no remote script origins

**Three-tier query policy, enforced in the core, not the caller.** Every connection carries a mode:

| Mode | Allows | Use for |
|---|---|---|
| `ReadOnly` | SELECT, SHOW, EXPLAIN, WITH…SELECT | Production connections, MCP default |
| `ReadWrite` | + INSERT/UPDATE/DELETE, requires WHERE on U/D | Staging |
| `Full` | Everything including DDL | Local dev |

Enforce it in two layers, because either alone is insufficient:

1. **Parse with `sqlparser`** and reject disallowed statement types. Catches the obvious.
2. **Push down to the database.** Postgres: `SET TRANSACTION READ ONLY`. MySQL: `START TRANSACTION READ ONLY`. SQLite: open the connection with `SQLITE_OPEN_READONLY`. This is what catches what the parser misses.

   Note that the first two are not airtight. Postgres describes its mode as "a high-level notion of read-only that does not prevent all writes to disk," and MySQL read-only transactions can still modify temporary tables. Only SQLite's flag is a hard guarantee. So this is genuine defense-in-depth rather than a single reliable backstop — which is the argument for having both layers.

Relying on the parser alone is how these guards get bypassed — `sqlparser` doesn't handle every dialect extension, and a statement it fails to classify must be *rejected*, never passed through. Fail closed.

---

## 5. The MCP server

### Transport

Ship both:

- **stdio** — a separate small binary (`dbclient-mcp`) that talks to the running app over a local Unix socket / named pipe. This is what Claude Desktop and Claude Code spawn. It must be a separate binary because those clients spawn a *process* and speak newline-delimited JSON-RPC over its stdin/stdout; your GUI app can't be that process.
- **streamable HTTP** — bound to `127.0.0.1` on a random port, bearer-token authenticated, off by default. For remote and web-based clients.

The stdio shim is deliberately dumb: it forwards JSON-RPC to the app and streams responses back. All logic lives in the app, so there's one implementation of the policy engine. The MCP spec (revision 2026-07-28) defines exactly these two standard transports, and explicitly says custom transports over a reliable bidirectional byte stream — Unix sockets, TCP — should reuse stdio's framing, so the shim's socket hop is a sanctioned pattern rather than a hack.

**If the app isn't running,** the shim should say so in a structured MCP error rather than hanging. A common failure mode in MCP servers is a silent timeout that surfaces to the user as "Claude just stopped responding."

### Tool surface

Resist the urge to expose one `execute_sql` tool. Fine-grained tools mean the model picks correctly without burning tokens on exploration, and they let you apply different permissions per tool.

| Tool | Purpose |
|---|---|
| `list_connections` | Enumerate configured connections + their policy mode. No secrets. |
| `list_schemas` | Schemas/databases within a connection |
| `list_tables` | Tables, views, row estimates |
| `describe_table` | Columns, types, nullability, keys, indexes, FKs |
| `sample_rows` | First N rows — cheap grounding before writing a query |
| `run_query` | Execute SQL under the connection's policy |
| `explain_query` | Query plan without executing |
| `search_schema` | Fuzzy-find a column or table by name across the DB |
| `mongo_find` / `mongo_aggregate` | Mongo-native, since SQL doesn't apply |
| `redis_get` / `redis_scan` | Redis-native |

**Expose schemas as MCP *resources*, not just tools.** A resource per table (`db://conn-id/schema/table`) lets a client pull schema into context without a tool round-trip, which noticeably improves the quality of generated SQL.

### Guardrails that make it usable rather than terrifying

- **Read-only by default.** A new connection is `ReadOnly` for MCP even if the GUI has it as `ReadWrite`. Opting up is a deliberate per-connection toggle in settings.
- **Auto-LIMIT.** Inject `LIMIT 1000` when the query has no limit. Return `truncated: true` so the model knows.
- **Result budget.** Cap serialised output around 100KB. A `SELECT *` on a million-row table should return a helpful error, not blow up the context window.
- **Statement timeout.** 30s default, per-query overridable.
- **Single statement per call.** Reject `;`-chained input — this is the classic injection vector.
- **Write confirmation.** Any mutation returns a preview (`"this will affect 4,213 rows"`) and requires a second call with a confirmation token. Cheap to build, and it's the difference between a tool you trust with staging and one you don't.
- **Audit log.** Every MCP call — tool, connection, SQL, row count, duration — written to local SQLite and visible in an "AI Activity" panel in the app. Users need to see what the model did.

Redacting result values from the audit log by default is worth doing; you want the query text for debugging, not a second copy of your customer data sitting in a log file.

---

## 6. Repository layout

```
dbclient/
├── crates/
│   ├── core/          # Driver trait, Value, ResultSet, policy engine
│   ├── drivers/       # postgres.rs, mysql.rs, sqlite.rs, mongo.rs, redis.rs
│   ├── mcp/           # rmcp server — tools, resources, guardrails
│   └── mcp-stdio/     # thin shim binary for Claude Desktop / Claude Code
├── src-tauri/         # Tauri app, IPC commands, keyring, tunnels
├── src/               # React: sidebar, grid, editor, Mongo/Redis modes
└── docs/
```

The workspace split matters: `core` and `drivers` must not depend on Tauri. That keeps the door open for a CLI, a headless server, or a standalone MCP binary — and it stops UI concerns leaking into the engine.

---

## 7. Roadmap

**Phase 1 — Prove the core (1–2 weeks)**
Workspace scaffold. `Driver` trait + `Value`/`ResultSet`. SQLite driver only. Tauri window, connection list, table tree, read-only result grid. *Exit criteria: open a .sqlite file, browse tables, run a SELECT, see typed results.*

**Phase 2 — Real databases (2–3 weeks)**
Postgres + MySQL via sqlx. Keyring integration. Connection dialog with SSH tunnel support. Monaco editor with schema-aware autocomplete. Policy engine with both enforcement layers.

**Phase 3 — MCP (1–2 weeks)**
`rmcp` server, the tool surface above, the stdio shim, guardrails, audit log + AI Activity panel. *Exit criteria: Claude Desktop lists your connections and answers a question about your schema.*

**Phase 4 — Make it good (ongoing)**
Editable result grid with diff-preview before commit. Import/export (CSV, JSON, SQL). Query history. Mongo and Redis modes. Tabs, split panes, keyboard-first navigation.

Phase 3 is deliberately early. It's the differentiator, it's independently useful, and building it before the UI is polished keeps the core honest — anything the MCP server can't reach is a sign the abstraction leaked.

---

## 8. The two hard problems, solved

These are the two that sink DB clients, and both are architectural — you cannot retrofit either. Here's the actual design for each.

### 8a. Large result sets

**The failure mode.** `SELECT * FROM events` returns 4M rows. The driver buffers them all in Rust (2GB RSS), serialises them to JSON (another 4GB, transiently), pushes that across Tauri IPC, and `JSON.parse` blocks the webview's main thread for 40 seconds before the renderer OOMs. Every layer is wrong.

**The fix is a cursor protocol.** The core never materialises a full result set; the UI never receives more than a screenful.

```rust
pub struct Cursor {
    id: CursorId,
    conn: PooledConnection,
    stream: BoxStream<'static, Result<Row>>,
    buffer: VecDeque<Row>,     // bounded ring, ~5k rows
    absolute_pos: u64,
    exhausted: bool,
}

impl Cursor {
    /// UI asks for a window; only this crosses IPC.
    async fn fetch_window(&mut self, offset: u64, len: u32) -> Result<RowWindow>;
}
```

Four rules:

1. **Stream in the driver.** sqlx's `.fetch()` returns a `Stream` and pulls rows incrementally. Postgres gets real server-side portals (`DECLARE … CURSOR`) so the server doesn't buffer either. MySQL needs the streaming flag explicitly or the driver buffers the whole result client-side. SQLite is naturally step-wise.
2. **Bounded buffer, never unbounded.** Keep ~5k rows around the current viewport in Rust. Scrolling forward advances the stream; scrolling backward past the buffer re-runs with an offset, or replays from a saved position.
3. **IPC carries windows, not results.** `fetch_window(cursor_id, offset, 200)`. Cap any single response at ~2MB. The UI holds ~3 screens and evicts the rest.
4. **Virtualise the grid.** TanStack Virtual renders only visible rows into the DOM. Spacer divs give the scrollbar the right height from the row *estimate*.

**Row counts: estimate first, exact on demand.** `SELECT COUNT(*)` on a large table is a full scan that can take minutes, and it's what makes clients feel frozen right after a query returns. Use the planner's estimate immediately (`reltuples` from `pg_class`, `EXPLAIN` rows, `information_schema.TABLES.TABLE_ROWS`), show it as `~4,200,000`, and only compute the exact count if the user clicks the number. Sort/filter changes reset the cursor rather than re-counting.

**Cancellation is part of this, not separate.** A user who runs a runaway query must be able to stop it, and dropping the Rust future is *not* enough — the server keeps executing. Postgres needs `pg_cancel_backend(pid)` issued on a **second** connection; MySQL needs `KILL QUERY`. Capture the backend PID at connection time and store it on the cursor. Without this, one accidental cross join wedges a pooled connection until it times out.

**Export bypasses the UI entirely.** Streaming a million rows to CSV must go driver → file on the Rust side. Routing it through the webview to trigger a browser download is how clients OOM on export. Write to the chosen path directly and report progress over an event channel.

### 8b. Type fidelity

**The failure mode.** A Postgres `numeric(19,4)` holding `10000000000000.0001` gets read as `f64`, becomes `10000000000000.002`, and is written back. No error, no warning, and financial data is now wrong. Separately, `bigint` `9007199254740993` crosses into JavaScript, exceeds `Number.MAX_SAFE_INTEGER`, and silently becomes `...992`.

**The fix has three layers.**

**Layer 1 — never parse into a lossy type.** Read `numeric`/`decimal` in **text format** from the wire and keep the string. If you need arithmetic (sums in a footer), `rust_decimal` 1.43 handles ~28 significant digits, and `bigdecimal` beyond that — but for display and round-trip, the original string is both cheapest and exact.

**Layer 2 — a typed IPC envelope.** Plain JSON destroys this at the boundary, so don't send plain JSON. Send column type descriptors once, and values in a form JS can't mangle:

```jsonc
{
  "columns": [
    { "name": "id",     "logical": "int64",     "wire": "string" },
    { "name": "amount", "logical": "decimal",   "wire": "string", "scale": 4 },
    { "name": "note",   "logical": "text",      "wire": "string" },
    { "name": "meta",   "logical": "json",      "wire": "json"   }
  ],
  "rows": [["9007199254740993", "10000000000000.0001", "hi", {"k":1}]]
}
```

Anything that JavaScript cannot represent exactly — `int64`, `decimal`, `numeric`, `money`, `uint64` — travels as a **string**, tagged by its logical type. The grid reads `logical` to decide alignment (numeric → right), the editor to use, and the formatter. It never calls `Number()` on those values.

Note this also means **JSON `null` must be distinguishable from the string `"NULL"` and from empty string**. Use a real JSON `null` for SQL NULL and render it as a styled `NULL` chip, never as text a user could mistake for data.

**Layer 3 — write back with explicit casts, and only what changed.** Keep each cell's original raw text alongside its current value. On commit, diff, and emit parameterised SQL with explicit casts so the server does the conversion from the exact string:

```sql
UPDATE orders SET amount = $1::numeric WHERE id = $2::bigint
```

Never round-trip through a Rust or JS numeric type on the write path. And build the `WHERE` clause from the primary key — if a table has no PK, make the grid read-only and say why, rather than guessing with a full-row match that silently updates duplicates.

**Prove it with a property test.** This is the one place a round-trip test pays for itself immediately:

> For each supported type, insert a set of boundary values (`i64::MIN/MAX`, `numeric` at max precision, `±0.0`, infinities, empty string vs NULL, 4-byte UTF-8, `\0` in text, timestamps at DST transitions and year 9999), read them through the full stack, write them back unchanged, and assert the stored bytes are byte-identical.

Run it against real Postgres/MySQL/SQLite in CI via testcontainers. Every type-fidelity bug you will ever have is caught by this one test, and it costs an afternoon.

---

## 9. Implementation TODO

Checkable tasks in dependency order. Items marked **⚠︎** are architectural — doing them late means rewriting.

### Phase 1 — Core (1–2 weeks)

- [ ] Cargo workspace: `core`, `drivers`, `mcp`, `mcp-stdio`, `src-tauri`
- [ ] **⚠︎** `Value` enum with `Decimal(String)`, `Int(i64)`, `Unsupported { type_name, raw }`
- [ ] **⚠︎** `Driver` trait with both `query()` and `stream_query()` from day one
- [ ] **⚠︎** `Cursor` type with bounded ring buffer and `fetch_window(offset, len)`
- [ ] SQLite driver (open with `SQLITE_OPEN_READONLY` when policy says read-only)
- [ ] Tauri shell: connection list, schema tree, result grid
- [ ] **⚠︎** Grid virtualised with TanStack Virtual — not a plain `<table>`
- [ ] **⚠︎** Typed IPC envelope: column descriptors + lossy types as tagged strings
- [ ] Round-trip property test harness with boundary values, wired into CI

### Phase 2 — Real databases (2–3 weeks)

- [ ] Postgres driver via sqlx; read `numeric`/`int8` in text format
- [ ] Server-side portals (`DECLARE … CURSOR`) for streaming
- [ ] MySQL driver; **verify streaming is actually on**, not client-buffered
- [ ] Capture backend PID per connection for cancellation
- [ ] Query cancel: `pg_cancel_backend` / `KILL QUERY` on a second connection
- [ ] Row-count estimates from `reltuples` / `EXPLAIN`; exact count only on click
- [ ] Credentials in OS keychain via `keyring`; profiles in local SQLite
- [ ] **⚠︎** Policy engine: `sqlparser` classification **plus** DB-level pushdown, failing closed
- [ ] Monaco editor with schema-aware autocomplete
- [ ] Editable grid: PK-based `WHERE`, explicit casts, diff-only updates, read-only when no PK
- [ ] Streaming CSV/JSON export straight to disk, bypassing the webview

### Phase 2.5 — Connectivity (1–2 weeks) → see PLAN-2

- [ ] **⚠︎** `Transport` trait below `Driver`; `Direct` impl as a no-op refactor
- [ ] SSH tunnel via `russh` — **ssh-agent auth first**, then keys, password, keyboard-interactive
- [ ] Bind `127.0.0.1` only; allocate port 0 and read back the assigned port
- [ ] **⚠︎** `TunnelSupervisor`: `SELECT 1` health probe, backoff, **pool invalidation on drop**
- [ ] Tunnel status indicator + error messages that name the tunnel, not "connection refused"
- [ ] `~/.ssh/config` import via `ssh2-config`, including `ProxyJump` and `ProxyCommand`
- [ ] AWS SSM transport shelling out to `session-manager-plugin`; detect it on PATH at startup
- [ ] Proactive SSM tunnel rotation (~45 min) ahead of AWS's hourly WebSocket recycle
- [ ] `CredentialProvider` trait; RDS IAM tokens with a **separate signing-endpoint field**

### Phase 3 — MCP (1–2 weeks)

- [ ] `rmcp` 3.x server with `#[tool]` / `#[tool_router]` / `#[tool_handler]`
- [ ] Ten fine-grained tools (not one `execute_sql`)
- [ ] Schema exposed as MCP **resources** via `db://conn/schema/table` URI templates
- [ ] stdio shim binary → local socket → app
- [ ] Structured error when the app isn't running (never hang)
- [ ] Guardrails: read-only default, auto-`LIMIT`, 100KB budget, 30s timeout, single statement
- [ ] Write confirmation tokens with affected-row preview
- [ ] Audit log + "AI Activity" panel; redact result values by default
- [ ] Tunnel-aware: establish on demand, hide tunnel internals, clear error for interactive auth

### Design — Apple-native, runs alongside Phase 1, gates every UI PR → see PLAN-3

The schema is saved in `design/tokens.json` (source of truth) and `design/tokens.css` (what the app imports). `design/preview.html` renders both appearances from it.

- [ ] **⚠︎** Import `design/tokens.css` at the app root before any component; lint for raw hex/px in component CSS
- [ ] **⚠︎** System font (`-apple-system`) at 13px for chrome; `ui-monospace` (SF Mono) for data, bundled JetBrains Mono on Windows/Linux; `tabular-nums` on every numeric cell
- [ ] **⚠︎** Follow the user's macOS accent via CSS `AccentColor` / `AccentColorText`; systemBlue fallback elsewhere
- [ ] **⚠︎** Tauri window: `titleBarStyle: "Overlay"`, `hiddenTitle: true`, traffic lights inset; native title bar on Windows/Linux
- [ ] **⚠︎** Full-height translucent sidebar: `window-vibrancy` crate with `NSVisualEffectMaterial::Sidebar` + CSS `backdrop-filter`; solid `window` colour elsewhere
- [ ] Apple system palette from tokens: `window` / `content` / `separator` / four label opacities; systemGreen/Orange/Red/Yellow for meaning only
- [ ] Selection follows window focus: accent pill when active, `selection-unfocused` grey when inactive (listen to Tauri focus events → `.window-inactive` on `<html>`)
- [ ] Radii locked: 6px controls & sidebar selection, 10px popovers, 12px sheets. Shadows only on sheets, popovers, menus
- [ ] Native `<input>` for checkbox / radio / switch / select with `accent-color` — no custom-drawn controls
- [ ] Launcher as a compact welcome window (Xcode-style): large-title heading, search, grouped 28px rows, environment dot
- [ ] Unified toolbar in the title bar: sidebar toggle · segmented `Data | Structure | Query` · search field · inspector toggle
- [ ] Sidebar source list: uppercase `label-2` group headers, accent-coloured table glyphs, Favorites group, drag-to-resize 180–320px
- [ ] **Sidebar header:** segmented `Tables | Queries | History` (20px) above an always-visible **`Search tables`** field, `⌘⇧O` focuses it, `Esc` clears
- [ ] **⚠︎** Table search runs on an in-memory schema index (all schemas, tables, views, functions, columns) — never a live query; results within one keystroke
- [ ] Search behaviour: subsequence match, bold matched characters, rank exact › prefix › word-boundary › subsequence › favourites › recent; groups collapse to matches; `COLUMNS` secondary group; `↓` into results, `⏎` opens, `⌘⏎` new tab
- [ ] Toolbar field is `Filter rows` and only ever filters the grid — the two searches are never confused
- [ ] Data grid: 26px rows, alternating `alt-row`, hairline horizontal lines only, full-row accent selection, `headline` column headers with type beneath
- [ ] `⌘F` slides a filter strip down under the toolbar (Safari find-bar style) with editable chips — no filter modal
- [ ] Unsaved edits tint `yellow` at 18%; bottom bar `N unsaved changes · Revert · Save ⌘S` — Apple's verbs, appears only when dirty
- [ ] Connection form as a **sheet** attached to the window, right-aligned labels, default button bottom-right, staged `Test` output inline
- [ ] Inspector slides in from the right (260px) like Finder's Preview pane; `⌘I` toggles
- [ ] Query errors as a compact inline row between editor and results, token underlined in the editor; `⌘.` cancels
- [ ] Spotlight-style **Open Anything** `⌘P` on the popover material, 10px radius, no title bar
- [ ] **A real menu bar** (Tauri `Menu`): File · Edit · View · Connection · Query · Window · Help with every ⌘ shortcut
- [ ] Preferences window `⌘,` with toolbar tabs General · Editor · Connections · AI; under 20 options
- [ ] States per PLAN-3 §6: native `<progress>`, "No Rows" in `label-2`, tunnel-dropped dims content to 60%
- [ ] Motion: 200ms sheets/popovers, 150ms selection, Apple easing; nothing animates on launch; respect `prefers-reduced-motion`
- [ ] Window frame, sidebar width, and inspector state restore on relaunch
- [ ] Visual regression: screenshot `design/preview.html` and the real app in both appearances in CI; diff on every PR

### Tabs & workspace — Phase 2, see PLAN-4

- [ ] **⚠︎** Tab model: Table (with `Data | Structure` inside), Query, Saved Query; **exact open rules** — unmodified tab is replaced, modified tab is pinned and a new tab opens, double-click pins, right-click *Open in New Tab*, already-open objects switch instead of duplicating
- [ ] Tab context menu: Rename Tab, Close Tab, Close Other Tabs, Close Tabs to the Right, Pin, Move Tab to New Window
- [ ] **⚠︎** Tab state persisted per connection as you go — kind, editor text, cursor, filters, sort, scroll, split; restored on relaunch and after tunnel reconnect
- [ ] **⚠︎** Drafts auto-saved every keystroke (500ms debounce) — unsaved query text is never lost
- [ ] Tab bar: `‹ ›` back/forward (`⌘[` `⌘]`), unsaved dot replaces `×` until hover, environment dot, `＋`, `⧉` split, `≡` show-all-tabs (searchable)
- [ ] Shortcuts: `⌘T` new query, `⌘W` close (prompts on unsaved), `⌘⇧T` reopen, `⌘1–9`, `⌃Tab`, `⌘⇧[ ]` move, `⌘\` split, `⌘⇧R` rename
- [ ] Drag to reorder, drag out to new window, drag between windows of the same connection
- [ ] Split view: two panes max, each with its own tab strip; `⌘⌥←→` moves focus
- [ ] Saved queries: `⌘S` names on first save; ★ icon; sidebar Queries pane with folders; also plain `.sql` files on disk, folder watched; optional share-across-connections
- [ ] Query tabs auto-title from the first statement until renamed
- [ ] `Navigate` and `Connection` menus in the menu bar

### TablePlus parity — pulled into Phase 2

- [ ] **Console log** bottom panel (`⌘⇧C`): every statement the app or the AI runs, timestamp, duration, `All / App / AI` filter, click-to-open in a query tab
- [ ] **Reconnect strip**: red-tinted bar under the toolbar when the tunnel or connection drops; the strip *is* the reconnect button; auto-hides on recovery
- [ ] **Safe-mode lock** in the toolbar: cycles read-only ↔ read/write with confirmation on production; closed by default on prod
- [ ] **Switch-database popover** (cylinder glyph) + clickable **breadcrumb** `connection : database : table` in the title area, with TLS / tunnel glyph
- [ ] **Foreign-key navigation**: FK values are links; click jumps to the referenced row; `⌥click` opens in a new tab
- [ ] **Pending-changes badge** across all tabs on the save item; **Preview changes** popover shows the exact SQL with `Copy`
- [ ] Reload `⌘R` (re-fetch + refresh schema index); cancel-query toolbar item enabled only while running
- [ ] **⚠︎** Workspaces = connection : database, as **native macOS window tabs** (Tauri `tabbingIdentifier`); own-drawn strip on Windows/Linux; `Window › Move Tab to New Window`, `Merge All Windows`, `⌘⇧] [`
- [ ] **Database switcher `⌘K`** and **connection switcher `⌘⇧K`** popovers: `⏎` opens a new workspace, `⌥⏎` / right-click replaces current, right-click *Open in New Window*; `⌘N` new window
- [ ] Sidebar switcher icons on the traffic-light row: `◎ ⌘P` · `🛢 ⌘K` · `⇄ ⌘⇧K`
- [ ] Data view bottom bar: `＋ Row` (`⌘N`), `Duplicate row` (`⌘D`), selection count, `Columns` show/hide/reorder/freeze (persisted per table), `⚙` page size / go-to-row
- [ ] Query editor bar: cursor position, **Limit selector** (`No limit / 100 / 1000 / custom`, default 1000), **Beautify** `⌘I`, `Run Current ▾` with Run Selected, `Explain ▾`
- [ ] Multiple result sets → result tabs inside the results pane
- [ ] Sidebar: rename `Tables` → `Items`; group schema › type (Tables / Views / Functions / Sequences); filter popover (types, system schemas); `＋ ⌄` new-object menu; **History** pane with duration/rows/status
- [ ] Inspector: per-field type labels, `Search fields`, type-aware field editors (JSON tree, date picker, enum), `AI` tab with activity log + prompt field
- [ ] Connection colour tag (in addition to environment); import connection from URL; duplicate connection
- [ ] Copy rows as TSV / CSV / JSON / SQL insert / Markdown (`⌘⇧C` menu); DDL viewer at the bottom of Structure
- [ ] Keyboard-shortcuts cheat sheet `⌘/`

### Phase 4 — Polish (ongoing)

- [ ] Mongo mode: document list, JSON tree, filter/projection builder
- [ ] Redis mode: key browser with per-type editors
- [ ] Query history, saved queries, tabs, split panes
- [ ] Keyboard-first navigation
- [ ] GCP Cloud SQL Proxy and Azure Entra ID providers
- [ ] Structure editing via UI: accumulate column/index/FK changes, `Preview` the `ALTER`s, apply in a transaction where DDL is transactional (warn on MySQL)
- [ ] Import CSV / JSON / SQL with column-mapping sheet and 20-row preview; export adds SQL inserts and `.xlsx`
- [ ] Backup / restore via `pg_dump` / `mysqldump` if on PATH, with progress sheet
- [ ] Paste rows from clipboard / spreadsheet; user-defined snippets
- [ ] Plugins as local MCP servers (one extension surface for plugins and AI); ER diagram from the schema index

---

## 10. Naming and licensing

Pick the license before the first commit; changing it later requires every contributor's consent.

- **MIT / Apache-2.0** — maximum adoption, anyone can fork and sell it
- **GPL-3.0** — what Beekeeper Studio's community edition uses; forks must stay open
- **AGPL-3.0** — closes the "run it as a hosted service without contributing" gap

If you might later sell a paid tier, GPL or AGPL plus a CLA is the conventional route — it's what lets you dual-license.

---

## Next step

Say the word and I'll scaffold Phase 1: the Cargo workspace, the `Driver` trait and `Value` types, a working SQLite driver, and a Tauri window that browses a real database file.
