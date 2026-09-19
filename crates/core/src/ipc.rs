//! The IPC contract between the engine and every front-end (Tauri commands,
//! the MCP server, tests). Mirrored 1:1 in `src/ipc/types.ts`.
//!
//! Rules:
//! - Everything here is `Serialize + Deserialize` and uses `camelCase` on the wire.
//! - Values that JavaScript cannot represent exactly (int64, decimal, timestamps,
//!   bytes) travel as **strings**. `ColumnDesc.logical` tells the UI what they are.
//! - Credentials never appear in any of these types. Profiles carry ids; the
//!   engine resolves secrets from the OS keychain.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub type ConnectionId = String; // uuid v4
pub type WorkspaceId = String; // uuid v4
pub type CursorId = String; // uuid v4

// ───────────────────────── connections ─────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DriverKind {
    Postgres,
    Mysql,
    Sqlite,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Environment {
    #[default]
    Local,
    Staging,
    Production,
}

/// Query policy for a connection. Enforced in the engine in two layers
/// (statement classification + database-level read-only pushdown).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum PolicyMode {
    ReadOnly,
    #[default]
    ReadWrite,
    Full,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProfile {
    pub id: ConnectionId,
    pub name: String,
    pub driver: DriverKind,
    #[serde(default)]
    pub environment: Environment,
    #[serde(default)]
    pub policy: PolicyMode,
    /// Free colour tag (hex) shown beside the environment dot. Optional.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// Network drivers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    /// SQLite only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    #[serde(default)]
    pub ssl: SslMode,
    /// Whether a password is stored in the keychain for this profile.
    #[serde(default)]
    pub has_password: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<String>, // RFC 3339
    #[serde(default)]
    pub favorite: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
    /// Per-session statement timeout in milliseconds. `None` means no limit.
    /// This is the rail that actually stops a runaway query — SQL parsing in
    /// `policy.rs` is a UX layer, the server-side timeout is enforcement.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub statement_timeout_ms: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum SslMode {
    #[default]
    Prefer,
    Disable,
    Require,
}

/// Result of `connection_test`: one entry per stage so the UI can show
/// `tunnel ✓ · tcp ✓ · auth ✓ · 84 ms`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestReport {
    pub ok: bool,
    pub stages: Vec<TestStage>,
    pub server_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestStage {
    pub name: String, // "tcp" | "auth" | "query"
    pub ok: bool,
    pub duration_ms: u64,
    pub error: Option<String>,
}

// ───────────────────────── workspaces ─────────────────────────

/// A workspace = one connection + one database. Owns a pool and a console.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    pub id: WorkspaceId,
    pub connection_id: ConnectionId,
    pub connection_name: String,
    pub driver: DriverKind,
    pub environment: Environment,
    pub policy: PolicyMode,
    /// Current database (Postgres/MySQL) or file name (SQLite).
    pub database: String,
    /// Other databases reachable on this connection (for the ⌘K switcher).
    pub databases: Vec<String>,
    pub server_version: Option<String>,
    pub tls: bool,
}

// ───────────────────────── schema ─────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ObjectKind {
    Table,
    View,
    MaterializedView,
    Function,
    Sequence,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaIndex {
    pub schemas: Vec<SchemaInfo>,
    /// Flattened `schema.table.column` triples for the sidebar's Columns group.
    pub columns: Vec<ColumnRef>,
    pub generated_at: String, // RFC 3339
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaInfo {
    pub name: String,
    pub is_system: bool,
    pub objects: Vec<ObjectInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectInfo {
    pub schema: String,
    pub name: String,
    pub kind: ObjectKind,
    /// Planner estimate, never a COUNT(*). None when unknown.
    pub row_estimate: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnRef {
    pub schema: String,
    pub table: String,
    pub column: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableRef {
    pub schema: Option<String>,
    pub name: String,
}

/// Logical type — what the UI needs to align, format, and pick an editor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LogicalType {
    Bool,
    /// Fits in f64 exactly? No — Int is always sent as a string. See `WireKind`.
    Int,
    Float,
    Decimal,
    Text,
    Bytes,
    Json,
    Timestamp,
    Date,
    Time,
    Uuid,
    Array,
    Document,
    /// pgvector `vector` / `halfvec` / `sparsevec`. Carried as its text form —
    /// `[0.12,-0.04,…]` — because the point of the UI is to never show it.
    Vector,
    Unknown,
}

/// How the cell is encoded in JSON. The UI must not `Number()` a `String` cell.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WireKind {
    Bool,
    Number,
    String,
    Json,
}

impl LogicalType {
    pub fn wire(self) -> WireKind {
        match self {
            LogicalType::Bool => WireKind::Bool,
            LogicalType::Float => WireKind::Number,
            LogicalType::Json | LogicalType::Array | LogicalType::Document => WireKind::Json,
            _ => WireKind::String,
        }
    }
    pub fn is_numeric(self) -> bool {
        matches!(self, LogicalType::Int | LogicalType::Float | LogicalType::Decimal)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnDesc {
    pub name: String,
    /// Raw database type name, e.g. `numeric(19,4)`, `int8`, `varchar(255)`.
    pub data_type: String,
    pub logical: LogicalType,
    pub wire: WireKind,
    pub nullable: Option<bool>,
    /// Source table when known (for editing and FK navigation).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub table: Option<TableRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableSchema {
    pub table: TableRef,
    pub kind: ObjectKind,
    pub columns: Vec<ColumnInfo>,
    pub primary_key: Vec<String>,
    pub foreign_keys: Vec<ForeignKey>,
    pub indexes: Vec<IndexInfo>,
    pub ddl: Option<String>,
    pub row_estimate: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub logical: LogicalType,
    pub nullable: bool,
    pub default: Option<String>,
    pub is_primary_key: bool,
    pub ordinal: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKey {
    pub name: Option<String>,
    pub columns: Vec<String>,
    pub ref_table: TableRef,
    pub ref_columns: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexInfo {
    pub name: String,
    pub columns: Vec<String>,
    pub unique: bool,
    pub primary: bool,
}

// ───────────────────────── data ─────────────────────────

/// One cell on the wire. `serde_json::Value` is exactly the JSON shape:
/// null | bool | number (Float only) | string | object/array (Json).
pub type Cell = serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowWindow {
    pub cursor_id: CursorId,
    pub offset: u64,
    pub rows: Vec<Vec<Cell>>,
    /// Total rows buffered for this cursor so far.
    pub buffered: u64,
    /// True when the cursor hit its limit — there may be more rows on the server.
    pub truncated: bool,
    pub exhausted: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StatementKind {
    Select,
    Insert,
    Update,
    Delete,
    Ddl,
    Other,
}

/// A column as the catalogue describes it — everything a diff needs and
/// nothing it doesn't.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnSnapshot {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub default: Option<String>,
    pub ordinal: i32,
}

/// One table, flattened for comparison.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableSnapshot {
    pub table: TableRef,
    pub kind: ObjectKind,
    pub columns: Vec<ColumnSnapshot>,
    pub primary_key: Vec<String>,
    /// `name` → definition, so a changed index shows as changed rather than
    /// as one dropped and one added.
    pub indexes: Vec<IndexSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexSnapshot {
    pub name: String,
    pub definition: String,
    pub unique: bool,
}

/// Everything about one database's shape, in one round trip per driver.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaSnapshot {
    pub tables: Vec<TableSnapshot>,
    pub foreign_keys: Vec<GraphEdge>,
    pub generated_at: String,
}

/// Which side of the comparison something lives on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DiffStatus {
    /// In the left (source) only — applying the migration adds it.
    Added,
    /// In the right (target) only — the migration would have to drop it.
    Removed,
    /// Present on both, but different.
    Changed,
    Same,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnDiff {
    pub name: String,
    pub status: DiffStatus,
    pub left: Option<ColumnSnapshot>,
    pub right: Option<ColumnSnapshot>,
    /// Human-readable list of what differs: "type", "nullability", "default".
    pub changes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexDiff {
    pub name: String,
    pub status: DiffStatus,
    pub left: Option<IndexSnapshot>,
    pub right: Option<IndexSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableDiff {
    pub table: TableRef,
    /// A view is not a table: you cannot `ALTER` its columns, and recreating
    /// one needs its definition, which a column catalogue does not carry.
    pub kind: ObjectKind,
    pub status: DiffStatus,
    pub columns: Vec<ColumnDiff>,
    pub indexes: Vec<IndexDiff>,
    /// Primary key differs between the two sides.
    pub primary_key_changed: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaDiff {
    pub tables: Vec<TableDiff>,
    pub left_label: String,
    pub right_label: String,
    /// Counts for the header: added, removed, changed tables and columns.
    pub summary: DiffSummary,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffSummary {
    pub tables_added: u32,
    pub tables_removed: u32,
    pub tables_changed: u32,
    pub columns_added: u32,
    pub columns_removed: u32,
    pub columns_changed: u32,
}

/// One relationship in the schema map. `inferred` edges did not come from a
/// declared constraint — they are a naming-and-type guess, and are always
/// presented as one.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphEdge {
    pub from: TableRef,
    pub from_columns: Vec<String>,
    pub to: TableRef,
    pub to_columns: Vec<String>,
    /// Constraint name, when there is one.
    pub name: Option<String>,
    pub inferred: bool,
}

/// A table in the map.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    pub table: TableRef,
    pub kind: ObjectKind,
    pub columns: Vec<String>,
    pub row_estimate: Option<i64>,
}

/// The schema as a graph: what the map draws and what the model walks.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaGraph {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub generated_at: String,
}

/// What `sql_check` found in one statement: enough for the UI to decide
/// whether to offer a Run button, a confirmation, or neither.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatementCheck {
    pub sql: String,
    pub kind: StatementKind,
    /// `false` when `sqlparser` could not parse it — never run those silently.
    pub parsed: bool,
    /// `Some(false)` for an `UPDATE`/`DELETE` with no `WHERE`.
    pub has_where: Option<bool>,
    pub is_explain: bool,
    /// Whether this connection's policy lets it run at all.
    pub allowed: bool,
    /// Why not, when `allowed` is false.
    pub blocked_reason: Option<String>,
}

/// A dry run of the policy engine over SQL nobody has executed yet.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlCheck {
    pub statements: Vec<StatementCheck>,
    /// Every statement is a `SELECT`/`EXPLAIN` that parsed cleanly.
    pub read_only: bool,
    /// Every statement is allowed by the connection's policy.
    pub allowed: bool,
    pub policy: PolicyMode,
}

/// One statement's outcome. A `run_query` call returns one per statement.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub statement: String,
    pub kind: StatementKind,
    pub columns: Vec<ColumnDesc>,
    /// Present when the statement produced rows; fetch them with `cursor_fetch`.
    pub cursor_id: Option<CursorId>,
    pub row_count: Option<u64>,
    pub rows_affected: Option<u64>,
    pub truncated: bool,
    pub duration_ms: u64,
    pub error: Option<QueryError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryError {
    pub message: String,
    /// 1-based line / column into the statement when the server reports one.
    pub line: Option<u32>,
    pub column: Option<u32>,
    pub code: Option<String>,
    /// Set when the policy engine refused the statement.
    pub blocked_by_policy: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum SortDir {
    #[default]
    Asc,
    Desc,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sort {
    pub column: String,
    pub dir: SortDir,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FilterOp {
    Eq,
    Neq,
    Lt,
    Lte,
    Gt,
    Gte,
    Like,
    NotLike,
    In,
    IsNull,
    IsNotNull,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Filter {
    pub column: String,
    pub op: FilterOp,
    /// String form; the engine binds it as a parameter with a cast where needed.
    pub value: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TableQuery {
    pub filters: Vec<Filter>,
    pub sort: Vec<Sort>,
    pub limit: Option<u32>,
    pub offset: Option<u64>,
}

// ───────────────────────── editing ─────────────────────────

/// A single cell change. `pk` identifies the row; the engine emits
/// `UPDATE … SET col = $1::type WHERE pk = $2` with explicit casts.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellChange {
    pub pk: BTreeMap<String, Cell>,
    pub column: String,
    pub value: Cell,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowInsert {
    pub values: BTreeMap<String, Cell>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowDelete {
    pub pk: BTreeMap<String, Cell>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChangeSet {
    pub table: Option<TableRef>,
    pub updates: Vec<CellChange>,
    pub inserts: Vec<RowInsert>,
    pub deletes: Vec<RowDelete>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangePreview {
    pub statements: Vec<String>,
    pub affected_estimate: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeOutcome {
    pub statements: Vec<String>,
    pub rows_affected: u64,
    pub duration_ms: u64,
}

// ───────────────────────── console / history / saved ─────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConsoleSource {
    /// Statements the app ran on its own (introspection, edits).
    App,
    /// Statements the user typed.
    User,
    /// Statements issued through the MCP server.
    Ai,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleEntry {
    pub id: i64,
    pub workspace_id: Option<WorkspaceId>,
    pub connection_id: ConnectionId,
    pub source: ConsoleSource,
    pub sql: String,
    pub duration_ms: u64,
    pub rows: Option<u64>,
    pub error: Option<String>,
    pub at: String, // RFC 3339
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedQuery {
    pub id: String,
    pub connection_id: Option<ConnectionId>, // None = shared across connections
    pub name: String,
    pub folder: Option<String>,
    pub sql: String,
    pub updated_at: String,
}

// ───────────────────────── engine events (Tauri emits) ─────────────────────────

/// Emitted on the `plinth://event` channel.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum EngineEvent {
    ConnectionState {
        workspace_id: WorkspaceId,
        state: ConnectionState,
        detail: Option<String>,
    },
    ConsoleAppended {
        entry: ConsoleEntry,
    },
    SchemaChanged {
        workspace_id: WorkspaceId,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionState {
    Connecting,
    Up,
    Degraded,
    Down,
}

// ───────────────────────── command catalogue ─────────────────────────
//
// Tauri command name → (args) → result. Every command returns `Result<T, IpcError>`.
//
//   connections_list()                                   -> Vec<ConnectionProfile>
//   connections_save(profile, password?)                 -> ConnectionProfile
//   connections_delete(id)                               -> ()
//   connection_test(profile, password?)                  -> TestReport
//   workspace_open(connection_id, database?)             -> WorkspaceInfo
//   workspace_close(workspace_id)                        -> ()
//   workspace_set_safe_mode(workspace_id, on)            -> ()
//   window_open(open?, database?, from?)                 -> String (label)
//   window_focus(label)                                  -> bool
//   window_list()                                        -> Vec<String>
//   workspace_list()                                     -> Vec<WorkspaceInfo>
//   schema_index(workspace_id, refresh)                  -> SchemaIndex
//   table_describe(workspace_id, table)                  -> TableSchema
//   table_open(workspace_id, table, query)               -> QueryResult
//   table_count(workspace_id, table, exact)              -> u64
//   query_run(workspace_id, sql, limit?)                 -> Vec<QueryResult>
//   explain_hypothetical(workspace_id, sql, indexes)     -> String (plan JSON)
//   query_cancel(workspace_id)                           -> ()
//   cursor_fetch(cursor_id, offset, len)                 -> RowWindow
//   cursor_close(cursor_id)                              -> ()
//   changes_preview(workspace_id, changes)               -> ChangePreview
//   changes_apply(workspace_id, changes)                 -> ChangeOutcome
//   console_list(workspace_id?, limit)                   -> Vec<ConsoleEntry>
//   history_list(connection_id, limit)                   -> Vec<ConsoleEntry>
//   saved_list(connection_id?)                           -> Vec<SavedQuery>
//   saved_save(query)                                    -> SavedQuery
//   saved_delete(id)                                     -> ()
//   state_get(key)                                       -> serde_json::Value | null
//   state_set(key, value)                                -> ()
//   sqlite_pick_file()                                   -> Option<String>   (Tauri only)

#[derive(Debug, Clone, Serialize, Deserialize, thiserror::Error)]
#[serde(rename_all = "camelCase")]
#[error("{message}")]
pub struct IpcError {
    pub code: String, // "not-found" | "policy" | "driver" | "io" | "invalid" | "internal"
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl IpcError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.into(), message: message.into(), detail: None }
    }
    pub fn internal(e: impl std::fmt::Display) -> Self {
        Self::new("internal", e.to_string())
    }
    pub fn driver(e: impl std::fmt::Display) -> Self {
        Self::new("driver", e.to_string())
    }
    pub fn policy(message: impl Into<String>) -> Self {
        Self::new("policy", message)
    }
    pub fn not_found(what: impl Into<String>) -> Self {
        Self::new("not-found", what)
    }
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new("invalid", message)
    }
}

impl From<anyhow::Error> for IpcError {
    fn from(e: anyhow::Error) -> Self {
        IpcError::internal(e)
    }
}
impl From<sqlx::Error> for IpcError {
    fn from(e: sqlx::Error) -> Self {
        IpcError::driver(e)
    }
}
impl From<std::io::Error> for IpcError {
    fn from(e: std::io::Error) -> Self {
        IpcError::new("io", e.to_string())
    }
}
impl From<serde_json::Error> for IpcError {
    fn from(e: serde_json::Error) -> Self {
        IpcError::invalid(e.to_string())
    }
}
