//! The MCP `ServerHandler`: read-only tools over the engine plus two resources.
//!
//! Guardrails (docs/PLAN.md §5):
//! - every statement is classified and checked against `PolicyMode::ReadOnly`
//!   *before* reaching the engine, whatever the connection's own policy is;
//! - one statement per call;
//! - rows are capped by `limit` and the serialised output by [`OUTPUT_BUDGET`];
//! - everything runs with `ConsoleSource::Ai`, so the app's console shows it.

use plinth_core::policy;
use plinth_core::*;
use plinth_drivers::sql::quote_table;
use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{
    CallToolResult, ContentBlock, ListResourceTemplatesResult, ListResourcesResult,
    PaginatedRequestParams, ReadResourceRequestParams, ReadResourceResponse, ReadResourceResult,
    Resource, ResourceContents, ResourceTemplate, ServerCapabilities, ServerConfig,
};
use rmcp::service::RequestContext;
use rmcp::{schemars, tool, tool_handler, tool_router, ErrorData as McpError, RoleServer, ServerHandler};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

/// Serialised-output budget for `run_query` / `sample_rows` (bytes).
pub const OUTPUT_BUDGET: usize = 100 * 1024;
/// Default row cap for `run_query`.
pub const DEFAULT_QUERY_LIMIT: u32 = 200;
/// Default row cap for `sample_rows`.
pub const DEFAULT_SAMPLE_LIMIT: u32 = 20;
/// Hard ceiling on rows returned by any tool, whatever the caller asks for.
pub const MAX_ROWS: u32 = 1000;
/// Max hits from `search_schema`.
pub const SEARCH_LIMIT: usize = 50;

pub const INSTRUCTIONS: &str = "Plinth exposes the databases configured in the Plinth desktop app. \
Everything here is READ-ONLY: only SELECT (and EXPLAIN/SHOW-style reads) run; INSERT, UPDATE, \
DELETE, DDL and multi-statement scripts are refused regardless of the connection's own policy. \
Start with `list_connections` to get a `connection_id` (never guess one). Then use `list_schemas`, \
`list_tables`, `search_schema` and, before writing any SQL, `describe_table` for every table you \
reference — column names and types come from there, not from memory. `sample_rows` is a cheap way \
to see real values. `run_query` runs exactly one statement, caps rows with `limit` (default 200) \
and truncates output at ~100 KB; `truncated: true` means there is more. Queries run with the \
app's 30 s statement timeout and are logged in the app's console as AI activity. Resources: \
`plinth://connections` lists connections; `plinth://{connection_id}/schema/{schema}/{table}` is \
`describe_table` as JSON.";

// ───────────────────────── parameters ─────────────────────────

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ConnectionParams {
    /// Connection id from `list_connections`.
    pub connection_id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ListTablesParams {
    /// Connection id from `list_connections`.
    pub connection_id: String,
    /// Restrict to one schema (Postgres/MySQL). Omit for all non-system schemas.
    #[serde(default)]
    pub schema: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct TableParams {
    /// Connection id from `list_connections`.
    pub connection_id: String,
    /// Table or view name (unquoted).
    pub table: String,
    /// Schema the table lives in. Omit for SQLite or the connection's default schema.
    #[serde(default)]
    pub schema: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SampleRowsParams {
    /// Connection id from `list_connections`.
    pub connection_id: String,
    /// Table or view name (unquoted).
    pub table: String,
    /// Schema the table lives in. Omit for SQLite or the connection's default schema.
    #[serde(default)]
    pub schema: Option<String>,
    /// Rows to return (default 20, max 1000).
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct RunQueryParams {
    /// Connection id from `list_connections`.
    pub connection_id: String,
    /// One read-only SQL statement. No trailing second statement.
    pub sql: String,
    /// Rows to return (default 200, max 1000).
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SearchSchemaParams {
    /// Connection id from `list_connections`.
    pub connection_id: String,
    /// Substring (case-insensitive) matched against table and column names; the
    /// characters may also appear in order but non-adjacent (fuzzy).
    pub query: String,
}

// ───────────────────────── output shapes ─────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionSummary {
    pub id: String,
    pub name: String,
    pub driver: DriverKind,
    pub environment: Environment,
    /// The connection's own policy in the app. The MCP server always runs as read-only.
    pub policy: PolicyMode,
    pub database: Option<String>,
}

impl From<&ConnectionProfile> for ConnectionSummary {
    fn from(p: &ConnectionProfile) -> Self {
        let database = match p.driver {
            DriverKind::Sqlite => p
                .file_path
                .as_deref()
                .and_then(|f| std::path::Path::new(f).file_name())
                .map(|n| n.to_string_lossy().into_owned()),
            _ => p.database.clone(),
        };
        ConnectionSummary {
            id: p.id.clone(),
            name: p.name.clone(),
            driver: p.driver,
            environment: p.environment,
            policy: p.policy,
            database,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableSummary {
    pub schema: String,
    pub name: String,
    pub kind: ObjectKind,
    pub row_estimate: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnOut {
    pub name: String,
    pub r#type: String,
    pub logical: LogicalType,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryOut {
    pub statement: String,
    pub columns: Vec<ColumnOut>,
    pub rows: Vec<Vec<Cell>>,
    /// Rows returned here.
    pub row_count: usize,
    /// Rows affected, for the (read-only) statements that report it instead of rows.
    pub rows_affected: Option<u64>,
    /// True when rows were dropped: the engine hit `limit` or the output budget did.
    pub truncated: bool,
    pub duration_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaHit {
    pub kind: &'static str, // "table" | "column"
    pub schema: String,
    pub table: String,
    pub column: Option<String>,
    pub score: u32,
}

// ───────────────────────── server ─────────────────────────

#[derive(Clone)]
pub struct PlinthMcp {
    engine: Arc<Engine>,
    /// connection id → open workspace id (opened lazily on first use).
    workspaces: Arc<Mutex<HashMap<ConnectionId, WorkspaceId>>>,
    tool_router: ToolRouter<Self>,
}

/// A failure the model should see as tool output (bad SQL, unknown table…),
/// as opposed to a protocol error.
#[derive(Debug)]
pub struct ToolFailure(pub String);

impl From<IpcError> for ToolFailure {
    fn from(e: IpcError) -> Self {
        let mut msg = format!("{} ({})", e.message, e.code);
        if let Some(d) = e.detail {
            msg.push_str(": ");
            msg.push_str(&d);
        }
        ToolFailure(msg)
    }
}

impl From<serde_json::Error> for ToolFailure {
    fn from(e: serde_json::Error) -> Self {
        ToolFailure(format!("serialisation failed: {e}"))
    }
}

type ToolResult = Result<Value, ToolFailure>;

fn finish(r: ToolResult) -> Result<CallToolResult, McpError> {
    match r {
        Ok(v) => {
            let text = serde_json::to_string(&v)
                .map_err(|e| McpError::internal_error(e.to_string(), None))?;
            Ok(CallToolResult::success(vec![ContentBlock::text(text)]))
        }
        Err(ToolFailure(msg)) => Ok(CallToolResult::error(vec![ContentBlock::text(msg)])),
    }
}

fn clamp_limit(limit: Option<u32>, default: u32) -> u32 {
    limit.unwrap_or(default).clamp(1, MAX_ROWS)
}

fn table_ref(schema: Option<String>, table: String) -> TableRef {
    TableRef {
        schema: schema.filter(|s| !s.trim().is_empty()),
        name: table,
    }
}

impl PlinthMcp {
    pub fn new(engine: Arc<Engine>) -> Self {
        Self {
            engine,
            workspaces: Arc::new(Mutex::new(HashMap::new())),
            tool_router: Self::tool_router(),
        }
    }

    pub fn engine(&self) -> &Arc<Engine> {
        &self.engine
    }

    /// Workspace for a connection, opening it on first use. A workspace the
    /// engine no longer knows (closed, reconnect failure) is reopened.
    async fn workspace(&self, connection_id: &str) -> Result<WorkspaceInfo, ToolFailure> {
        let mut map = self.workspaces.lock().await;
        if let Some(ws_id) = map.get(connection_id) {
            let open = self.engine.workspace_list().await?;
            if let Some(info) = open.into_iter().find(|w| &w.id == ws_id) {
                return Ok(info);
            }
            map.remove(connection_id);
        }
        // Validate the id first so the error names the real problem.
        let known = self.engine.connections_list().await?;
        if !known.iter().any(|c| c.id == connection_id) {
            return Err(ToolFailure(format!(
                "Unknown connection_id {connection_id:?}. Call list_connections to get a valid id."
            )));
        }
        let info = self.engine.workspace_open(connection_id, None).await?;
        map.insert(connection_id.to_string(), info.id.clone());
        Ok(info)
    }

    /// Run one read-only statement and materialise its rows, honouring the
    /// row `limit` and the output budget.
    async fn run_read_only(
        &self,
        ws: &WorkspaceInfo,
        sql: &str,
        limit: u32,
    ) -> Result<QueryOut, ToolFailure> {
        let statements = policy::split_statements(ws.driver, sql);
        let stmt = match statements.len() {
            0 => return Err(ToolFailure("No SQL statement given.".into())),
            1 => statements.into_iter().next().unwrap_or_default(),
            n => {
                return Err(ToolFailure(format!(
                    "run_query accepts exactly one statement; got {n}. Send them one call at a time."
                )))
            }
        };
        let classified = policy::classify(ws.driver, &stmt);
        if let Err(e) = policy::check(PolicyMode::ReadOnly, &classified, &stmt) {
            return Err(ToolFailure(format!(
                "{} The MCP server is read-only; writes are not available through this tool.",
                e.message
            )));
        }

        let mut results = self
            .engine
            .query_run(&ws.id, stmt.clone(), Some(limit), ConsoleSource::Ai)
            .await?;
        let r = results
            .pop()
            .ok_or_else(|| ToolFailure("The engine returned no result.".into()))?;
        if let Some(err) = r.error {
            return Err(ToolFailure(format!("Query failed: {}", err.message)));
        }

        let columns = r
            .columns
            .iter()
            .map(|c| ColumnOut {
                name: c.name.clone(),
                r#type: c.data_type.clone(),
                logical: c.logical,
            })
            .collect();

        let mut rows = Vec::new();
        let mut truncated = r.truncated;
        if let Some(cursor_id) = &r.cursor_id {
            let window = self.engine.cursor_fetch(cursor_id, 0, limit).await;
            let _ = self.engine.cursor_close(cursor_id).await;
            let window = window?;
            // Reserve a little for the envelope around the rows.
            let mut budget = OUTPUT_BUDGET.saturating_sub(2048);
            for row in window.rows {
                let size = serde_json::to_vec(&row)?.len() + 1;
                if size > budget {
                    truncated = true;
                    break;
                }
                budget -= size;
                rows.push(row);
            }
            if !window.exhausted && window.buffered > rows.len() as u64 {
                truncated = true;
            }
        }

        Ok(QueryOut {
            statement: stmt,
            columns,
            row_count: rows.len(),
            rows,
            rows_affected: r.rows_affected,
            truncated,
            duration_ms: r.duration_ms,
        })
    }

    async fn describe(&self, ws: &WorkspaceInfo, table: TableRef) -> Result<Value, ToolFailure> {
        let schema = self.engine.table_describe(&ws.id, table).await?;
        Ok(json!({
            "table": schema.table,
            "kind": schema.kind,
            "rowEstimate": schema.row_estimate,
            "columns": schema.columns.iter().map(|c| json!({
                "name": c.name,
                "type": c.data_type,
                "logical": c.logical,
                "nullable": c.nullable,
                "default": c.default,
                "primaryKey": c.is_primary_key,
            })).collect::<Vec<_>>(),
            "primaryKey": schema.primary_key,
            "foreignKeys": schema.foreign_keys,
            "indexes": schema.indexes,
        }))
    }

    // ───────────── tool bodies (also callable directly from tests) ─────────────

    pub async fn do_list_connections(&self) -> ToolResult {
        let list = self.engine.connections_list().await?;
        let out: Vec<ConnectionSummary> = list.iter().map(ConnectionSummary::from).collect();
        Ok(serde_json::to_value(out)?)
    }

    pub async fn do_list_schemas(&self, connection_id: &str) -> ToolResult {
        let ws = self.workspace(connection_id).await?;
        let index = self.engine.schema_index(&ws.id, false).await?;
        let out: Vec<Value> = index
            .schemas
            .iter()
            .map(|s| {
                json!({
                    "name": s.name,
                    "isSystem": s.is_system,
                    "objectCount": s.objects.len(),
                })
            })
            .collect();
        Ok(json!({ "database": ws.database, "schemas": out }))
    }

    pub async fn do_list_tables(&self, connection_id: &str, schema: Option<String>) -> ToolResult {
        let ws = self.workspace(connection_id).await?;
        let index = self.engine.schema_index(&ws.id, false).await?;
        let schema = schema.filter(|s| !s.trim().is_empty());
        let mut out = Vec::new();
        for s in &index.schemas {
            match &schema {
                Some(want) if want != &s.name => continue,
                None if s.is_system => continue,
                _ => {}
            }
            for o in &s.objects {
                if matches!(
                    o.kind,
                    ObjectKind::Table | ObjectKind::View | ObjectKind::MaterializedView
                ) {
                    out.push(TableSummary {
                        schema: o.schema.clone(),
                        name: o.name.clone(),
                        kind: o.kind,
                        row_estimate: o.row_estimate,
                    });
                }
            }
        }
        if out.is_empty() {
            if let Some(want) = &schema {
                if !index.schemas.iter().any(|s| &s.name == want) {
                    return Err(ToolFailure(format!(
                        "Schema {want:?} not found. Call list_schemas for the available names."
                    )));
                }
            }
        }
        Ok(serde_json::to_value(out)?)
    }

    pub async fn do_describe_table(
        &self,
        connection_id: &str,
        table: String,
        schema: Option<String>,
    ) -> ToolResult {
        let ws = self.workspace(connection_id).await?;
        self.describe(&ws, table_ref(schema, table)).await
    }

    pub async fn do_sample_rows(
        &self,
        connection_id: &str,
        table: String,
        schema: Option<String>,
        limit: Option<u32>,
    ) -> ToolResult {
        let ws = self.workspace(connection_id).await?;
        let limit = clamp_limit(limit, DEFAULT_SAMPLE_LIMIT);
        let table = table_ref(schema, table);
        // Resolve through the engine first so an unknown table yields a clear error.
        self.engine.table_describe(&ws.id, table.clone()).await?;
        let sql = format!("SELECT * FROM {} LIMIT {limit}", quote_table(ws.driver, &table));
        let out = self.run_read_only(&ws, &sql, limit).await?;
        Ok(serde_json::to_value(out)?)
    }

    pub async fn do_run_query(&self, connection_id: &str, sql: String, limit: Option<u32>) -> ToolResult {
        let ws = self.workspace(connection_id).await?;
        let limit = clamp_limit(limit, DEFAULT_QUERY_LIMIT);
        let out = self.run_read_only(&ws, &sql, limit).await?;
        Ok(serde_json::to_value(out)?)
    }

    pub async fn do_search_schema(&self, connection_id: &str, query: &str) -> ToolResult {
        let needle = query.trim().to_lowercase();
        if needle.is_empty() {
            return Err(ToolFailure("query must not be empty".into()));
        }
        let ws = self.workspace(connection_id).await?;
        let index = self.engine.schema_index(&ws.id, false).await?;
        let mut hits: Vec<SchemaHit> = Vec::new();
        for s in &index.schemas {
            if s.is_system {
                continue;
            }
            for o in &s.objects {
                if let Some(score) = fuzzy_score(&o.name.to_lowercase(), &needle) {
                    hits.push(SchemaHit {
                        kind: "table",
                        schema: o.schema.clone(),
                        table: o.name.clone(),
                        column: None,
                        score: score + 5, // tables outrank columns at equal quality
                    });
                }
            }
        }
        let system: std::collections::HashSet<&str> = index
            .schemas
            .iter()
            .filter(|s| s.is_system)
            .map(|s| s.name.as_str())
            .collect();
        for c in &index.columns {
            if system.contains(c.schema.as_str()) {
                continue;
            }
            if let Some(score) = fuzzy_score(&c.column.to_lowercase(), &needle) {
                hits.push(SchemaHit {
                    kind: "column",
                    schema: c.schema.clone(),
                    table: c.table.clone(),
                    column: Some(c.column.clone()),
                    score,
                });
            }
        }
        hits.sort_by(|a, b| {
            b.score
                .cmp(&a.score)
                .then_with(|| a.table.cmp(&b.table))
                .then_with(|| a.column.cmp(&b.column))
        });
        hits.truncate(SEARCH_LIMIT);
        Ok(serde_json::to_value(hits)?)
    }
}

/// Score a candidate against a lower-cased needle: exact > prefix > substring
/// > in-order subsequence. `None` when it does not match at all.
pub fn fuzzy_score(candidate: &str, needle: &str) -> Option<u32> {
    if candidate == needle {
        return Some(100);
    }
    if candidate.starts_with(needle) {
        return Some(80);
    }
    if candidate.contains(needle) {
        return Some(60);
    }
    let mut it = candidate.chars();
    for ch in needle.chars() {
        it.by_ref().find(|c| *c == ch)?;
    }
    // Shorter candidates are tighter matches.
    Some(30u32.saturating_sub((candidate.len().saturating_sub(needle.len())) as u32 / 4))
}

#[tool_router]
impl PlinthMcp {
    #[tool(
        name = "list_connections",
        description = "List the database connections configured in Plinth: id, name, driver, environment, policy and database. Use the id as connection_id in every other tool. Hosts, users and secrets are never exposed."
    )]
    pub async fn list_connections(&self) -> Result<CallToolResult, McpError> {
        finish(self.do_list_connections().await)
    }

    #[tool(
        name = "list_schemas",
        description = "List the schemas in a connection's current database (SQLite reports a single 'main' schema)."
    )]
    pub async fn list_schemas(
        &self,
        Parameters(p): Parameters<ConnectionParams>,
    ) -> Result<CallToolResult, McpError> {
        finish(self.do_list_schemas(&p.connection_id).await)
    }

    #[tool(
        name = "list_tables",
        description = "List tables and views with their planner row estimates. Optionally restrict to one schema; system schemas are skipped unless named explicitly."
    )]
    pub async fn list_tables(
        &self,
        Parameters(p): Parameters<ListTablesParams>,
    ) -> Result<CallToolResult, McpError> {
        finish(self.do_list_tables(&p.connection_id, p.schema).await)
    }

    #[tool(
        name = "describe_table",
        description = "Columns (name, type, nullable, default, primary key), primary key, foreign keys and indexes of one table. Call this before writing SQL that touches the table."
    )]
    pub async fn describe_table(
        &self,
        Parameters(p): Parameters<TableParams>,
    ) -> Result<CallToolResult, McpError> {
        finish(self.do_describe_table(&p.connection_id, p.table, p.schema).await)
    }

    #[tool(
        name = "sample_rows",
        description = "Return the first N rows of a table (default 20) to see real values before writing a query."
    )]
    pub async fn sample_rows(
        &self,
        Parameters(p): Parameters<SampleRowsParams>,
    ) -> Result<CallToolResult, McpError> {
        finish(
            self.do_sample_rows(&p.connection_id, p.table, p.schema, p.limit)
                .await,
        )
    }

    #[tool(
        name = "run_query",
        description = "Run ONE read-only SQL statement (SELECT / EXPLAIN / SHOW). Returns columns and rows as compact JSON, capped at `limit` rows (default 200, max 1000) and ~100 KB; `truncated: true` means more rows exist. Writes, DDL and multi-statement scripts are refused."
    )]
    pub async fn run_query(
        &self,
        Parameters(p): Parameters<RunQueryParams>,
    ) -> Result<CallToolResult, McpError> {
        finish(self.do_run_query(&p.connection_id, p.sql, p.limit).await)
    }

    #[tool(
        name = "search_schema",
        description = "Find tables and columns whose name matches a query (case-insensitive substring, then fuzzy). Top 50 hits, best first."
    )]
    pub async fn search_schema(
        &self,
        Parameters(p): Parameters<SearchSchemaParams>,
    ) -> Result<CallToolResult, McpError> {
        finish(self.do_search_schema(&p.connection_id, &p.query).await)
    }
}

// ───────────────────────── resources ─────────────────────────

pub const CONNECTIONS_URI: &str = "plinth://connections";
pub const TABLE_TEMPLATE: &str = "plinth://{connection_id}/schema/{schema}/{table}";

/// Parse `plinth://<connection_id>/schema/<schema>/<table>`.
/// An empty or `-` schema segment means "no schema" (SQLite / default schema).
pub fn parse_table_uri(uri: &str) -> Option<(String, Option<String>, String)> {
    let rest = uri.strip_prefix("plinth://")?;
    let mut parts = rest.split('/');
    let conn = parts.next().filter(|s| !s.is_empty())?;
    if parts.next()? != "schema" {
        return None;
    }
    let schema = parts.next()?;
    let table = parts.next().filter(|s| !s.is_empty())?;
    if parts.next().is_some() {
        return None;
    }
    let schema = match schema {
        "" | "-" => None,
        s => Some(s.to_string()),
    };
    Some((conn.to_string(), schema, table.to_string()))
}

fn json_resource(uri: &str, value: &Value) -> Result<ReadResourceResponse, McpError> {
    let text = serde_json::to_string_pretty(value)
        .map_err(|e| McpError::internal_error(e.to_string(), None))?;
    Ok(ReadResourceResult::new(vec![
        ResourceContents::text(text, uri).with_mime_type("application/json"),
    ])
    .into())
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for PlinthMcp {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(
            ServerCapabilities::builder()
                .enable_tools()
                .enable_resources()
                .build(),
        )
        .with_server_info(
            rmcp::model::Implementation::new("plinth-mcp", env!("CARGO_PKG_VERSION"))
                .with_title("Plinth")
                .with_description("Read-only access to the databases configured in Plinth.")
                .with_website_url("https://github.com/od/plinth"),
        )
        .with_instructions(INSTRUCTIONS)
    }

    async fn list_resources(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListResourcesResult, McpError> {
        let resource = Resource::new(CONNECTIONS_URI, "connections")
            .with_title("Plinth connections")
            .with_description("The connections configured in the Plinth app (no secrets).")
            .with_mime_type("application/json");
        Ok(ListResourcesResult::with_all_items(vec![resource]))
    }

    async fn list_resource_templates(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListResourceTemplatesResult, McpError> {
        let t = ResourceTemplate::new(TABLE_TEMPLATE, "table-schema")
            .with_title("Table schema")
            .with_description(
                "describe_table as JSON. Use `-` for the schema segment on SQLite or for the default schema.",
            )
            .with_mime_type("application/json");
        Ok(ListResourceTemplatesResult::with_all_items(vec![t]))
    }

    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResponse, McpError> {
        let uri = request.uri.as_str();
        if uri == CONNECTIONS_URI {
            let v = self
                .do_list_connections()
                .await
                .map_err(|e| McpError::internal_error(e.0, None))?;
            return json_resource(uri, &v);
        }
        let Some((conn, schema, table)) = parse_table_uri(uri) else {
            return Err(McpError::resource_not_found(
                format!("Unknown resource {uri}; expected {CONNECTIONS_URI} or {TABLE_TEMPLATE}"),
                None,
            ));
        };
        let ws = self
            .workspace(&conn)
            .await
            .map_err(|e| McpError::resource_not_found(e.0, None))?;
        let v = self
            .describe(&ws, table_ref(schema, table))
            .await
            .map_err(|e| McpError::resource_not_found(e.0, None))?;
        json_resource(uri, &v)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fuzzy_ranks_exact_prefix_substring_subsequence() {
        assert_eq!(fuzzy_score("users", "users"), Some(100));
        assert_eq!(fuzzy_score("user_roles", "user"), Some(80));
        assert_eq!(fuzzy_score("app_users", "user"), Some(60));
        assert!(fuzzy_score("u_s_e_r", "user").is_some_and(|s| s < 60));
        assert_eq!(fuzzy_score("orders", "xyz"), None);
    }

    #[test]
    fn table_uri_round_trip() {
        assert_eq!(
            parse_table_uri("plinth://abc/schema/public/users"),
            Some(("abc".into(), Some("public".into()), "users".into()))
        );
        assert_eq!(
            parse_table_uri("plinth://abc/schema/-/users"),
            Some(("abc".into(), None, "users".into()))
        );
        assert_eq!(parse_table_uri("plinth://abc/tables/users"), None);
        assert_eq!(parse_table_uri("plinth://abc/schema/public/users/extra"), None);
        assert_eq!(parse_table_uri("http://abc/schema/public/users"), None);
    }
}
