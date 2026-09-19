# plinth-mcp

A stdio [Model Context Protocol](https://modelcontextprotocol.io) server that
gives Claude (Desktop, Code, or any MCP client) **read-only** access to the
database connections you have configured in the Plinth app.

It opens the same data directory as the app (`plinth.db`, WAL mode, safe for
two processes), reads passwords from the same OS keychain entries
(service `dev.plinth.app`), and runs every statement through the engine as
`ConsoleSource::Ai`, so everything the model does shows up in the app's console.

## Guardrails

- **Read-only, always.** Every statement is parsed and classified; only
  `SELECT` / `EXPLAIN` / `SHOW`-style reads run, regardless of the
  connection's own policy in the app. Unparseable SQL is refused (fail closed).
- **One statement per call.** `;`-chained scripts are rejected.
- **Row and size caps.** `limit` (default 200, max 1000) plus a ~100 KB
  serialised-output budget; `truncated: true` tells the model there is more.
- **30 s statement timeout** (the engine default).
- **No secrets.** `list_connections` returns id, name, driver, environment,
  policy and database name — never hosts, users or passwords.

Writes with confirmation tokens are Phase 2 and not available yet.

## Tools

| Tool | Arguments | Returns |
|---|---|---|
| `list_connections` | — | `[{id, name, driver, environment, policy, database}]` |
| `list_schemas` | `connection_id` | `{database, schemas: [{name, isSystem, objectCount}]}` |
| `list_tables` | `connection_id`, `schema?` | `[{schema, name, kind, rowEstimate}]` |
| `describe_table` | `connection_id`, `table`, `schema?` | columns, primary key, foreign keys, indexes |
| `sample_rows` | `connection_id`, `table`, `schema?`, `limit=20` | first N rows |
| `run_query` | `connection_id`, `sql`, `limit=200` | `{columns, rows, rowCount, truncated, durationMs}` |
| `search_schema` | `connection_id`, `query` | top 50 table/column name matches |

Resources: `plinth://connections` (the connection list) and
`plinth://{connection_id}/schema/{schema}/{table}` (`describe_table` as JSON;
use `-` as the schema segment for SQLite or the default schema).

## Install

Build the binary:

```sh
cargo build --release -p plinth-mcp
# → target/release/plinth-mcp
```

### Claude Desktop

Add to `claude_desktop_config.json`
(macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{ "mcpServers": { "plinth": { "command": "/path/to/plinth-mcp" } } }
```

### Claude Code

```sh
claude mcp add plinth /path/to/plinth-mcp
```

## Data directory

By default the server uses the app's data directory
(Tauri's `app_data_dir()` for the bundle id `dev.plinth.app`):

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/dev.plinth.app` |
| Linux | `$XDG_DATA_HOME/dev.plinth.app` (default `~/.local/share/dev.plinth.app`) |
| Windows | `%APPDATA%\dev.plinth.app` |

Override it with `--data-dir <dir>` (used by the tests and useful for a
scratch profile):

```sh
plinth-mcp --data-dir /tmp/plinth-scratch
```

Logs go to stderr (`RUST_LOG=debug` for more); stdout is the JSON-RPC
transport and must stay clean.

## Keychain

Passwords come from the OS keychain (Keychain Services, Windows Credential
Manager, or the freedesktop Secret Service over D-Bus). If the keychain is
unavailable — for example a headless Linux session without a Secret Service —
the server logs a warning and falls back to an in-memory store, so only
connections without a stored password (SQLite, trust auth) will open.
