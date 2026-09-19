//! The `Driver` trait every database backend implements, and the factory the
//! engine uses to construct one. Drivers know nothing about workspaces, tabs,
//! policy or the console — the engine owns all of that.

use crate::ipc::*;
use async_trait::async_trait;
use std::sync::Arc;

/// A fully materialised statement result: columns + buffered rows.
/// Phase 1 buffers up to `QueryOpts.limit` rows in memory; the engine serves
/// windows from the buffer. True server-side cursors are a later phase and
/// will slot in behind the same shape.
#[derive(Debug, Clone, Default)]
pub struct Materialized {
    pub columns: Vec<ColumnDesc>,
    pub rows: Vec<Vec<Cell>>,
    /// The driver stopped reading because it hit `limit`; more rows may exist.
    pub truncated: bool,
    /// For non-row statements.
    pub rows_affected: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct QueryOpts {
    /// Max rows to buffer for row-producing statements. `None` = driver default (1000).
    pub limit: Option<u32>,
    /// Ask the database to run in a read-only transaction / connection.
    pub read_only: bool,
    /// Statement timeout.
    pub timeout_ms: Option<u64>,
}

impl Default for QueryOpts {
    fn default() -> Self {
        Self { limit: Some(1000), read_only: false, timeout_ms: Some(30_000) }
    }
}

/// Server-side limits applied to every connection in a pool, in
/// `after_connect`. These are enforcement; `policy.rs` is only classification.
#[derive(Debug, Clone, Copy, Default)]
pub struct SessionLimits {
    /// Milliseconds before the server cancels a statement. `None` = no limit.
    pub statement_timeout_ms: Option<u32>,
}

/// Everything the engine needs from a backend. All methods take `&self`;
/// implementations wrap an `sqlx::Pool` (cheap to clone, internally synchronised).
#[async_trait]
pub trait Driver: Send + Sync {
    fn kind(&self) -> DriverKind;

    /// Human-readable server version, e.g. `PostgreSQL 16.3`.
    async fn server_version(&self) -> Result<String, IpcError>;

    /// Is the connection encrypted?
    fn tls(&self) -> bool;

    /// Cheap liveness probe (`SELECT 1` / `PING`). Doubles as the keepalive.
    async fn ping(&self) -> Result<(), IpcError>;

    /// Databases reachable on this server (for the ⌘K switcher). SQLite returns
    /// the single file name.
    async fn list_databases(&self) -> Result<Vec<String>, IpcError>;

    /// The database this driver is currently attached to.
    fn current_database(&self) -> String;

    /// Full schema index: schemas → objects, plus the flattened column list.
    /// Must use planner estimates, never `COUNT(*)`.
    async fn schema_index(&self) -> Result<SchemaIndex, IpcError>;

    async fn describe_table(&self, table: &TableRef) -> Result<TableSchema, IpcError>;

    /// The whole database's shape in a handful of round trips — what the diff
    /// compares. `describe_table` per table would be N calls against two
    /// databases at once, which is the reason nobody ships this feature.
    async fn schema_snapshot(&self) -> Result<SchemaSnapshot, IpcError>;

    /// Every declared foreign key in the database, in one round trip. The map
    /// needs all of them at once; `describe_table` per table would be N calls.
    async fn foreign_keys(&self) -> Result<Vec<GraphEdge>, IpcError>;

    /// Exact (`COUNT(*)`) or estimated row count.
    async fn count(&self, table: &TableRef, exact: bool) -> Result<u64, IpcError>;

    /// Execute exactly one statement. The engine has already split and
    /// classified it; the driver must not split further.
    async fn execute(&self, sql: &str, opts: &QueryOpts) -> Result<Materialized, IpcError>;

    /// `EXPLAIN` a statement on **one** connection, with zero or more
    /// hypothetical indexes in place for the duration.
    ///
    /// This exists because HypoPG keeps its hypothetical indexes in the
    /// session's private memory: create them on one pooled connection and
    /// `EXPLAIN` on another, and the planner has never heard of them — which
    /// looks exactly like "this index would not help". So the whole sequence
    /// has to be pinned to a single connection, which nothing else in the
    /// Driver API needs and `execute` cannot promise.
    ///
    /// Returns the plan as JSON. Drivers without hypothetical indexes say so.
    async fn explain_hypothetical(&self, _sql: &str, _indexes: &[String]) -> Result<String, IpcError> {
        Err(IpcError::invalid(
            "Hypothetical indexes are a PostgreSQL feature (the hypopg extension).",
        ))
    }

    /// Best-effort cancellation of whatever this driver is currently running.
    /// Postgres: `pg_cancel_backend` on a second connection; MySQL: `KILL QUERY`;
    /// SQLite: `sqlite3_interrupt` (or no-op).
    async fn cancel(&self) -> Result<(), IpcError>;

    /// Quote an identifier for this dialect: `"name"` / `` `name` ``.
    fn quote_ident(&self, ident: &str) -> String;

    /// Render a table reference with schema if present.
    fn quote_table(&self, table: &TableRef) -> String {
        match &table.schema {
            Some(s) if !s.is_empty() => format!("{}.{}", self.quote_ident(s), self.quote_ident(&table.name)),
            _ => self.quote_ident(&table.name),
        }
    }

    /// Build a `SELECT` for the data view. Filters and sort are validated
    /// against the table's columns by the engine before this is called; values
    /// are rendered as SQL literals with dialect-correct escaping (Phase 1) —
    /// parameter binding across three dialects is a Phase 2 refinement.
    fn build_table_select(&self, table: &TableRef, schema: &TableSchema, query: &TableQuery) -> String;

    /// Render a change set as statements with explicit casts and PK-based
    /// `WHERE`. Returns the statements without executing them.
    fn render_changes(&self, schema: &TableSchema, changes: &ChangeSet) -> Result<Vec<String>, IpcError>;

    /// Execute statements in one transaction and return rows affected.
    async fn apply(&self, statements: &[String]) -> Result<u64, IpcError>;

    /// Close pools.
    async fn close(&self);
}

/// How the engine obtains a `Driver` for a profile.
#[async_trait]
pub trait DriverFactory: Send + Sync {
    /// `database` overrides `profile.database` (for the ⌘K switcher).
    async fn connect(
        &self,
        profile: &ConnectionProfile,
        password: Option<&str>,
        database: Option<&str>,
        read_only: bool,
    ) -> Result<Arc<dyn Driver>, IpcError>;
}

/// Map a raw database type name to a logical type. Shared by all drivers.
pub fn logical_type_for(driver: DriverKind, raw: &str) -> LogicalType {
    let t = raw.to_ascii_lowercase();
    let t = t.trim();
    // strip modifiers: "numeric(19,4)" -> "numeric", "character varying(255)" -> "character varying"
    let base = t.split('(').next().unwrap_or(t).trim();
    let base = base.trim_end_matches("[]");
    if t.ends_with("[]") {
        return LogicalType::Array;
    }
    match driver {
        DriverKind::Postgres => match base {
            "bool" | "boolean" => LogicalType::Bool,
            "int2" | "int4" | "int8" | "smallint" | "integer" | "bigint" | "serial" | "bigserial" | "smallserial" | "oid" => LogicalType::Int,
            "float4" | "float8" | "real" | "double precision" => LogicalType::Float,
            "numeric" | "decimal" | "money" => LogicalType::Decimal,
            "json" | "jsonb" => LogicalType::Json,
            "timestamp" | "timestamptz" | "timestamp without time zone" | "timestamp with time zone" => LogicalType::Timestamp,
            "date" => LogicalType::Date,
            "time" | "timetz" | "time without time zone" | "time with time zone" => LogicalType::Time,
            "uuid" => LogicalType::Uuid,
            "bytea" => LogicalType::Bytes,
            // pgvector. `vector(1536)` loses its modifier above, like numeric.
            "vector" | "halfvec" | "sparsevec" => LogicalType::Vector,
            "text" | "varchar" | "character varying" | "char" | "character" | "bpchar" | "name" | "citext" | "inet" | "cidr" | "macaddr" | "interval" | "xml" => LogicalType::Text,
            _ => LogicalType::Unknown,
        },
        DriverKind::Mysql => match base {
            "bool" | "boolean" => LogicalType::Bool,
            "tinyint" | "smallint" | "mediumint" | "int" | "integer" | "bigint" | "year" => LogicalType::Int,
            "float" | "double" | "real" => LogicalType::Float,
            "decimal" | "numeric" | "dec" | "fixed" => LogicalType::Decimal,
            "json" => LogicalType::Json,
            "datetime" | "timestamp" => LogicalType::Timestamp,
            "date" => LogicalType::Date,
            "time" => LogicalType::Time,
            "binary" | "varbinary" | "blob" | "tinyblob" | "mediumblob" | "longblob" | "bit" => LogicalType::Bytes,
            "char" | "varchar" | "text" | "tinytext" | "mediumtext" | "longtext" | "enum" | "set" => LogicalType::Text,
            _ => LogicalType::Unknown,
        },
        DriverKind::Sqlite => {
            // SQLite type affinity rules.
            if base.contains("int") {
                LogicalType::Int
            } else if base.contains("bool") {
                LogicalType::Bool
            } else if base.contains("char") || base.contains("clob") || base.contains("text") {
                LogicalType::Text
            } else if base.contains("blob") || base.is_empty() {
                if base.is_empty() { LogicalType::Unknown } else { LogicalType::Bytes }
            } else if base.contains("real") || base.contains("floa") || base.contains("doub") {
                LogicalType::Float
            } else if base.contains("numeric") || base.contains("decimal") {
                LogicalType::Decimal
            } else if base.contains("json") {
                LogicalType::Json
            } else if base.contains("datetime") || base.contains("timestamp") {
                LogicalType::Timestamp
            } else if base.contains("date") {
                LogicalType::Date
            } else if base.contains("time") {
                LogicalType::Time
            } else {
                LogicalType::Unknown
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn maps_common_types() {
        assert_eq!(logical_type_for(DriverKind::Postgres, "numeric(19,4)"), LogicalType::Decimal);
        assert_eq!(logical_type_for(DriverKind::Postgres, "int8"), LogicalType::Int);
        assert_eq!(logical_type_for(DriverKind::Postgres, "text[]"), LogicalType::Array);
        assert_eq!(logical_type_for(DriverKind::Mysql, "decimal(10,2)"), LogicalType::Decimal);
        assert_eq!(logical_type_for(DriverKind::Sqlite, "VARCHAR(20)"), LogicalType::Text);
        assert_eq!(logical_type_for(DriverKind::Sqlite, "INTEGER"), LogicalType::Int);
        assert_eq!(logical_type_for(DriverKind::Postgres, "tsvector"), LogicalType::Unknown);
    }
}
