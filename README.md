# Plinth

A native-feeling, open-source database client with a built-in MCP server — so Claude can query your databases through the same engine, policy, and audit log you use.

**Stack:** Tauri 2 · Rust (`sqlx`, `sqlparser`, `rmcp`) · React 19 · TypeScript · CodeMirror 6

**Databases:** PostgreSQL · MySQL/MariaDB · SQLite (Phase 1). MongoDB and Redis are Phase 4.

| | |
|---|---|
| Design | `docs/PLAN-3-DESIGN.md` — Apple HIG–native; tokens in `design/tokens.css`, preview in `design/preview.html` |
| Architecture | `docs/PLAN.md` — engine, typed IPC, cursor windows, policy engine, MCP |
| Connectivity | `docs/PLAN-2-CONNECTIVITY.md` — SSH, AWS SSM, tunnel supervisor (Phase 2.5, not yet built) |
| Tabs & parity | `docs/PLAN-4-FEATURES.md` — workspaces, tab rules, TablePlus gap analysis |
| JSON | `docs/PLAN-11-JSON.md` — the viewer: flat index, scoped search, five ways in |
| Guide | `docs/PLAN-10-GUIDE.md` — the in-app tour, the "how do I…" index, the comparison |
| Rails & types | `docs/PLAN-5-RAILS.md` — session limits, prod mode, editor mechanics, vector/JSON, drift |

## What you get for free here

Every row below is something a competing client charges for, or does not ship
at all. Sources: TablePlus's own free-vs-paid page, Beekeeper Studio's pricing
page, DBeaver's edition comparison.

| | Plinth | Elsewhere |
|---|---|---|
| Tabs and windows | unlimited | TablePlus free: **2 tabs, 2 windows, 2 filters** ($99 to lift) |
| Query history, searchable | in the sidebar, per connection | Beekeeper: paid tier |
| Saved connections | local, in the OS keychain | Beekeeper: cloud workspaces are paid |
| Local LLM, no cloud | built in, any Ollama model | DBeaver: PRO only — and their most-upvoted community request |
| MCP server for agents | built in, read-only, audited | nobody ships this in the client |
| Embeddings you can read | `vector` columns as a fingerprint, one-click similarity search | nobody: people fall back to Jupyter |
| Schema map | a graph that also feeds the AI its join paths | DBeaver ER diagrams are CE; the AI half is nobody |
| Charts | five forms, transparent PNG export | Beekeeper: advanced export is paid |

## Embeddings

`pgvector` columns are a solved problem everywhere except the client: a
`vector(1536)` is 20 KB of digits, so every GUI prints 20 KB of digits.

Plinth decodes pgvector's binary wire format — `vector`, `halfvec`, `sparsevec`
— and shows what you actually want: a sparkline fingerprint, the dimension
count, and the norm, so you can tell two rows apart at a glance and spot an
un-normalised vector immediately.

Right-click any row → **Find similar rows by <column>**. It writes the query:

```sql
-- Nearest neighbours by cosine distance.
-- Swap the operator for another metric: <-> euclidean, <#> inner product.
SELECT t.id, t.title,
       t.embedding <=> (SELECT embedding FROM public.documents WHERE id = 1) AS distance
FROM public.documents t
WHERE t.id <> 1
ORDER BY distance
LIMIT 20;
```

It anchors to the source row by key rather than pasting 1,536 literals, so the
query stays readable and re-runnable — and the other two metrics are one edit
away, documented in the query itself.

## Layout

```
crates/core      plinth-core     engine: Value/Cell rules, Driver trait, policy (sqlparser), cursors, store, IPC contract
crates/drivers   plinth-drivers  SQLite / Postgres / MySQL over sqlx — typed decoding, introspection, edits
crates/mcp       plinth-mcp      stdio MCP server (read-only) sharing the same data dir and console
src-tauri        plinth-app      Tauri shell: commands, native menu, keychain secrets, vibrancy
src/             React UI        launcher, workspace, sidebar search, tabs, virtualised grid, editor, inspector, console
design/          tokens.json (source of truth), tokens.css (imported by the app), preview.html
docs/            the four plans
```

`crates/core/src/ipc.rs` and `src/ipc/types.ts` are the same contract in two languages. Change both or neither.

## Run

Prerequisites: Rust 1.85+, Node 22+, and Tauri's platform deps (macOS: Xcode CLT; Linux: `libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev`).

```sh
npm install
npm run tauri dev          # the app, with hot reload
npm run dev                # UI only, in a browser, against an in-memory mock backend
cargo test --workspace     # engine, drivers (SQLite), MCP smoke test
npm run build              # tsc --strict + vite
```

```sh
npm run check              # tsc + vitest + cargo test — the same gate CI runs
npm test                   # the frontend tests alone
```

SQLite and the dialect tests run with no setup. Postgres and MySQL need a
server, so their suites are `#[ignore]`d until you point them at one:

```sh
PLINTH_TEST_PG_URL=postgres://user:pass@localhost/db \
  cargo test -p plinth-drivers --test postgres -- --ignored
PLINTH_TEST_MYSQL_URL=mysql://user:pass@localhost/db \
  cargo test -p plinth-drivers --test mysql -- --ignored
```

CI runs all of it on every push — types, unit tests and clippy on Linux, the
driver suites against real `postgres` and `mysql` service containers, and a
compile of the workspace on macOS, Windows and Linux.

## Connect Claude

Build the MCP server and register it:

```sh
cargo build --release -p plinth-mcp
claude mcp add plinth "$PWD/target/release/plinth-mcp"        # Claude Code
```

or in Claude Desktop's config:

```json
{ "mcpServers": { "plinth": { "command": "/absolute/path/to/target/release/plinth-mcp" } } }
```

Tools: `list_connections`, `list_schemas`, `list_tables`, `describe_table`, `sample_rows`, `run_query`, `search_schema`. Read-only, single statement, 100 KB output budget, every call logged to the app's Console under the **AI** filter. Connections are shared with the app (same data dir, passwords stay in the OS keychain); hosts, users and secrets are never exposed to the model. Details in `crates/mcp/README.md`.

## Status

Phase 1 is done and verified end to end (SQLite, real Tauri binary, real MCP stdio session). See `docs/PLAN.md` §9 for the checklist; the unticked items are next.

Known gaps worth knowing before you rely on it:

- No SSH / SSM tunnelling yet (PLAN-2). Postgres/MySQL connect directly.
- Workspaces are drawn as our own strip; native macOS window tabs (`tabbingIdentifier`) are configured but multi-window workspaces are not wired.
- Cursors buffer up to the tab's limit in memory (default 1 000); true server-side cursors are a later phase.
- PK literals in generated `UPDATE`s are typed from the wire (strings); Postgres gets explicit `::type` casts, SQLite/MySQL rely on affinity.
- On Linux the OS keychain needs a Secret Service (GNOME Keyring / KWallet); without one, passwords live in memory for the session only.
- The Windows/Linux title bar is native; the macOS overlay/vibrancy path is untested here.

## License

AGPL-3.0. See `docs/PLAN.md` §10 for why.
