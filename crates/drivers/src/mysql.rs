//! MySQL / MariaDB driver. Databases are schemas: only the current database
//! is indexed, the others are listed (empty) so the switcher can offer them.
//! Row estimates are `information_schema.TABLES.TABLE_ROWS`.

use crate::exec::{apply_in_transaction, db_error, fetch_limited, is_timeout, with_timeout, DEFAULT_LIMIT};
use crate::sql;
use crate::value::{decode_mysql, logical_from_raw};
use async_trait::async_trait;
use plinth_core::*;
use sqlx::mysql::{MySqlConnectOptions, MySqlPool, MySqlPoolOptions, MySqlRow, MySqlSslMode};
use sqlx::Row;
use std::sync::Mutex;
use std::time::Duration;

pub struct MysqlDriver {
    pool: MySqlPool,
    database: String,
    tls: bool,
    /// `CONNECTION_ID()` of the connection running the current `execute`.
    current_conn: Mutex<Option<u64>>,
}

const SYSTEM_SCHEMAS: [&str; 4] = ["information_schema", "mysql", "performance_schema", "sys"];

/// Catalog rows are decoded through the wire decoder so integer widths and
/// signedness differences between MySQL and MariaDB do not matter.
fn cell_str(row: &MySqlRow, idx: usize) -> Option<String> {
    match decode_mysql(row, idx) {
        Cell::String(s) => Some(s),
        Cell::Number(n) => Some(n.to_string()),
        Cell::Bool(b) => Some(if b { "1" } else { "0" }.to_string()),
        _ => None,
    }
}

fn cell_i64(row: &MySqlRow, idx: usize) -> Option<i64> {
    cell_str(row, idx).and_then(|s| s.parse::<f64>().ok()).map(|f| f as i64)
}

impl MysqlDriver {
    pub async fn connect(opts: MySqlConnectOptions, read_only: bool, limits: SessionLimits) -> Result<Self, IpcError> {
        let mut pool_opts = MySqlPoolOptions::new().max_connections(4).acquire_timeout(Duration::from_secs(10));
        let timeout_ms = limits.statement_timeout_ms;
        if read_only || timeout_ms.is_some() {
            pool_opts = pool_opts.after_connect(move |conn, _meta| {
                Box::pin(async move {
                    if read_only {
                        sqlx::raw_sql("SET SESSION transaction_read_only = 1").execute(&mut *conn).await?;
                    }
                    if let Some(ms) = timeout_ms {
                        // MySQL 5.7+ only, and SELECT only. MariaDB has
                        // `max_statement_time` in seconds instead, so a failure
                        // here must not take the connection down with it.
                        if sqlx::raw_sql(sqlx::AssertSqlSafe(format!("SET SESSION max_execution_time = {ms}"))).execute(&mut *conn).await.is_err() {
                            let secs = (ms as f64 / 1000.0).max(0.001);
                            let _ = sqlx::raw_sql(sqlx::AssertSqlSafe(format!("SET SESSION max_statement_time = {secs}"))).execute(&mut *conn).await;
                        }
                    }
                    Ok(())
                })
            });
        }
        let ssl_required = matches!(opts.get_ssl_mode(), MySqlSslMode::Required | MySqlSslMode::VerifyCa | MySqlSslMode::VerifyIdentity);
        let pool = pool_opts.connect_with(opts).await.map_err(db_error)?;

        let db_row = sqlx::query("SELECT DATABASE()").fetch_one(&pool).await.map_err(db_error)?;
        let database = cell_str(&db_row, 0).unwrap_or_default();
        let tls = match sqlx::query("SHOW STATUS LIKE 'Ssl_cipher'").fetch_optional(&pool).await {
            Ok(Some(row)) => cell_str(&row, 1).map(|v| !v.is_empty()).unwrap_or(ssl_required),
            _ => ssl_required,
        };
        Ok(Self { pool, database, tls, current_conn: Mutex::new(None) })
    }

    pub fn pool(&self) -> &MySqlPool {
        &self.pool
    }

    fn set_conn(&self, id: Option<u64>) {
        let mut guard = self.current_conn.lock().unwrap_or_else(|p| p.into_inner());
        *guard = id;
    }

    fn schema_of(&self, table: &TableRef) -> String {
        table.schema.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| self.database.clone())
    }

    /// `(kind, row estimate)` from `information_schema.TABLES`.
    async fn table_meta(&self, schema: &str, name: &str) -> Result<(ObjectKind, Option<i64>), IpcError> {
        let row = sqlx::query("SELECT TABLE_TYPE, TABLE_ROWS FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?")
            .bind(schema)
            .bind(name)
            .fetch_optional(&self.pool)
            .await
            .map_err(db_error)?
            .ok_or_else(|| IpcError::not_found(format!("table {schema}.{name} not found")))?;
        let kind = match cell_str(&row, 0).as_deref() {
            Some("VIEW") | Some("SYSTEM VIEW") => ObjectKind::View,
            _ => ObjectKind::Table,
        };
        Ok((kind, cell_i64(&row, 1)))
    }
}

#[async_trait]
impl Driver for MysqlDriver {
    fn kind(&self) -> DriverKind {
        DriverKind::Mysql
    }

    async fn server_version(&self) -> Result<String, IpcError> {
        let row = sqlx::query("SELECT VERSION()").fetch_one(&self.pool).await.map_err(db_error)?;
        let v = cell_str(&row, 0).unwrap_or_default();
        let flavour = if v.to_ascii_lowercase().contains("mariadb") { "MariaDB" } else { "MySQL" };
        let short = v.split('-').next().unwrap_or(&v);
        Ok(format!("{flavour} {short}"))
    }

    fn tls(&self) -> bool {
        self.tls
    }

    async fn ping(&self) -> Result<(), IpcError> {
        sqlx::query("SELECT 1").execute(&self.pool).await.map_err(db_error)?;
        Ok(())
    }

    async fn list_databases(&self) -> Result<Vec<String>, IpcError> {
        let rows = sqlx::query("SHOW DATABASES").fetch_all(&self.pool).await.map_err(db_error)?;
        Ok(rows.iter().filter_map(|r| cell_str(r, 0)).collect())
    }

    fn current_database(&self) -> String {
        self.database.clone()
    }

    async fn schema_index(&self) -> Result<SchemaIndex, IpcError> {
        let db = self.database.clone();
        let db_rows = sqlx::query("SHOW DATABASES").fetch_all(&self.pool).await.map_err(db_error)?;
        let mut schemas: Vec<SchemaInfo> = db_rows
            .iter()
            .filter_map(|r| cell_str(r, 0))
            .map(|name| SchemaInfo { is_system: SYSTEM_SCHEMAS.contains(&name.as_str()), name, objects: Vec::new() })
            .collect();
        if !schemas.iter().any(|s| s.name == db) && !db.is_empty() {
            schemas.push(SchemaInfo { name: db.clone(), is_system: false, objects: Vec::new() });
        }

        let mut objects = Vec::new();
        let tables = sqlx::query(
            "SELECT TABLE_NAME, TABLE_TYPE, TABLE_ROWS FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME",
        )
        .bind(&db)
        .fetch_all(&self.pool)
        .await
        .map_err(db_error)?;
        for r in &tables {
            let Some(name) = cell_str(r, 0) else { continue };
            let kind = match cell_str(r, 1).as_deref() {
                Some("VIEW") | Some("SYSTEM VIEW") => ObjectKind::View,
                _ => ObjectKind::Table,
            };
            let row_estimate = if kind == ObjectKind::Table { cell_i64(r, 2) } else { None };
            objects.push(ObjectInfo { schema: db.clone(), name, kind, row_estimate });
        }
        let routines = sqlx::query("SELECT ROUTINE_NAME FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_NAME")
            .bind(&db)
            .fetch_all(&self.pool)
            .await
            .map_err(db_error)?;
        for r in &routines {
            if let Some(name) = cell_str(r, 0) {
                objects.push(ObjectInfo { schema: db.clone(), name, kind: ObjectKind::Function, row_estimate: None });
            }
        }
        if let Some(s) = schemas.iter_mut().find(|s| s.name == db) {
            s.objects = objects;
        }

        let col_rows = sqlx::query(
            "SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION",
        )
        .bind(&db)
        .fetch_all(&self.pool)
        .await
        .map_err(db_error)?;
        let columns = col_rows
            .iter()
            .filter_map(|r| Some(ColumnRef { schema: db.clone(), table: cell_str(r, 0)?, column: cell_str(r, 1)? }))
            .collect();

        Ok(SchemaIndex { schemas, columns, generated_at: chrono::Utc::now().to_rfc3339() })
    }

    async fn describe_table(&self, table: &TableRef) -> Result<TableSchema, IpcError> {
        let schema = self.schema_of(table);
        let name = table.name.clone();
        let (kind, row_estimate) = self.table_meta(&schema, &name).await?;

        let pk_rows = sqlx::query(
            "SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE \
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY' ORDER BY ORDINAL_POSITION",
        )
        .bind(&schema)
        .bind(&name)
        .fetch_all(&self.pool)
        .await
        .map_err(db_error)?;
        let primary_key: Vec<String> = pk_rows.iter().filter_map(|r| cell_str(r, 0)).collect();

        let col_rows = sqlx::query(
            "SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, ORDINAL_POSITION, EXTRA \
             FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
        )
        .bind(&schema)
        .bind(&name)
        .fetch_all(&self.pool)
        .await
        .map_err(db_error)?;
        let mut columns = Vec::with_capacity(col_rows.len());
        for r in &col_rows {
            let Some(cname) = cell_str(r, 0) else { continue };
            let data_type = cell_str(r, 1).unwrap_or_default();
            let nullable = cell_str(r, 2).map(|v| v.eq_ignore_ascii_case("YES")).unwrap_or(true);
            let mut default = cell_str(r, 3);
            let extra = cell_str(r, 5).unwrap_or_default();
            if default.is_none() && extra.to_ascii_lowercase().contains("auto_increment") {
                default = Some("AUTO_INCREMENT".into());
            }
            columns.push(ColumnInfo {
                logical: logical_from_raw(DriverKind::Mysql, &data_type),
                is_primary_key: primary_key.contains(&cname),
                name: cname,
                data_type,
                nullable,
                default,
                ordinal: cell_i64(r, 4).unwrap_or(0).max(0) as u32,
            });
        }

        let fk_rows = sqlx::query(
            "SELECT CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_SCHEMA, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME \
             FROM information_schema.KEY_COLUMN_USAGE \
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL \
             ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION",
        )
        .bind(&schema)
        .bind(&name)
        .fetch_all(&self.pool)
        .await
        .map_err(db_error)?;
        let mut foreign_keys: Vec<ForeignKey> = Vec::new();
        for r in &fk_rows {
            let cname = cell_str(r, 0);
            let (Some(col), Some(ref_table), Some(ref_col)) = (cell_str(r, 1), cell_str(r, 3), cell_str(r, 4)) else { continue };
            match foreign_keys.iter_mut().find(|fk| fk.name == cname) {
                Some(fk) => {
                    fk.columns.push(col);
                    fk.ref_columns.push(ref_col);
                }
                None => foreign_keys.push(ForeignKey {
                    name: cname,
                    columns: vec![col],
                    ref_table: TableRef { schema: cell_str(r, 2), name: ref_table },
                    ref_columns: vec![ref_col],
                }),
            }
        }

        let idx_rows = sqlx::query(
            "SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME FROM information_schema.STATISTICS \
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX",
        )
        .bind(&schema)
        .bind(&name)
        .fetch_all(&self.pool)
        .await
        .map_err(db_error)?;
        let mut indexes: Vec<IndexInfo> = Vec::new();
        for r in &idx_rows {
            let Some(iname) = cell_str(r, 0) else { continue };
            let col = cell_str(r, 2).unwrap_or_else(|| "<expression>".into());
            match indexes.iter_mut().find(|i| i.name == iname) {
                Some(i) => i.columns.push(col),
                None => indexes.push(IndexInfo {
                    unique: cell_i64(r, 1) == Some(0),
                    primary: iname == "PRIMARY",
                    name: iname,
                    columns: vec![col],
                }),
            }
        }
        indexes.sort_by_key(|i| !i.primary);

        let table_ref = TableRef { schema: Some(schema), name };
        let ddl = match sqlx::query(sqlx::AssertSqlSafe(format!("SHOW CREATE TABLE {}", self.quote_table(&table_ref))))
            .fetch_optional(&self.pool)
            .await
        {
            Ok(Some(row)) => cell_str(&row, 1),
            _ => None,
        };

        Ok(TableSchema { table: table_ref, kind, columns, primary_key, foreign_keys, indexes, ddl, row_estimate })
    }

    async fn schema_snapshot(&self) -> Result<SchemaSnapshot, IpcError> {
        let col_rows = sqlx::query(
            "SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, ORDINAL_POSITION, COLUMN_KEY \
             FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, ORDINAL_POSITION",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(db_error)?;

        let idx_rows = sqlx::query(
            "SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS COLS \
             FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() \
             GROUP BY TABLE_NAME, INDEX_NAME, NON_UNIQUE ORDER BY TABLE_NAME, INDEX_NAME",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(db_error)?;

        let mut tables: Vec<TableSnapshot> = Vec::new();
        let mut at: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        for r in &col_rows {
            let schema = cell_str(r, 0);
            let name = cell_str(r, 1).unwrap_or_default();
            let index = *at.entry(name.clone()).or_insert_with(|| {
                tables.push(TableSnapshot {
                    table: TableRef { schema: schema.clone(), name: name.clone() },
                    kind: ObjectKind::Table,
                    columns: Vec::new(),
                    primary_key: Vec::new(),
                    indexes: Vec::new(),
                });
                tables.len() - 1
            });
            let column = cell_str(r, 2).unwrap_or_default();
            if cell_str(r, 7).as_deref() == Some("PRI") {
                tables[index].primary_key.push(column.clone());
            }
            tables[index].columns.push(ColumnSnapshot {
                name: column,
                data_type: cell_str(r, 3).unwrap_or_default(),
                nullable: cell_str(r, 4).as_deref() == Some("YES"),
                default: cell_str(r, 5),
                ordinal: cell_str(r, 6).and_then(|v| v.parse().ok()).unwrap_or(0),
            });
        }
        for r in &idx_rows {
            let Some(&i) = at.get(&cell_str(r, 0).unwrap_or_default()) else { continue };
            let name = cell_str(r, 1).unwrap_or_default();
            let unique = cell_str(r, 2).as_deref() == Some("0");
            let cols = cell_str(r, 3).unwrap_or_default();
            tables[i].indexes.push(IndexSnapshot {
                definition: format!("{} INDEX {name} ({cols})", if unique { "UNIQUE" } else { "" }).trim().to_string(),
                name,
                unique,
            });
        }

        Ok(SchemaSnapshot { tables, foreign_keys: self.foreign_keys().await?, generated_at: plinth_core::store::now_rfc3339() })
    }

    async fn foreign_keys(&self) -> Result<Vec<GraphEdge>, IpcError> {
        // Composite keys arrive as one row per column; ORDINAL_POSITION keeps
        // the column order, which is what makes the ON clause correct.
        let rows = sqlx::query(
            "SELECT CONSTRAINT_NAME AS name, TABLE_SCHEMA AS from_schema, TABLE_NAME AS from_table, \
                    COLUMN_NAME AS from_col, REFERENCED_TABLE_SCHEMA AS to_schema, \
                    REFERENCED_TABLE_NAME AS to_table, REFERENCED_COLUMN_NAME AS to_col \
             FROM information_schema.KEY_COLUMN_USAGE \
             WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL \
             ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(db_error)?;

        let mut out: Vec<GraphEdge> = Vec::new();
        for r in &rows {
            let name: Option<String> = cell_str(r, 0);
            let from = TableRef { schema: cell_str(r, 1), name: cell_str(r, 2).unwrap_or_default() };
            let from_col = cell_str(r, 3).unwrap_or_default();
            let to = TableRef { schema: cell_str(r, 4), name: cell_str(r, 5).unwrap_or_default() };
            let to_col = cell_str(r, 6).unwrap_or_default();
            match out.last_mut() {
                Some(e) if e.name == name && e.from == from => {
                    e.from_columns.push(from_col);
                    e.to_columns.push(to_col);
                }
                _ => out.push(GraphEdge { from, from_columns: vec![from_col], to, to_columns: vec![to_col], name, inferred: false }),
            }
        }
        Ok(out)
    }

    async fn count(&self, table: &TableRef, exact: bool) -> Result<u64, IpcError> {
        if !exact {
            let (_, est) = self.table_meta(&self.schema_of(table), &table.name).await?;
            if let Some(n) = est {
                return Ok(n.max(0) as u64);
            }
        }
        let sql = format!("SELECT COUNT(*) FROM {}", self.quote_table(table));
        let row = sqlx::query(sqlx::AssertSqlSafe(sql)).fetch_one(&self.pool).await.map_err(db_error)?;
        Ok(cell_i64(&row, 0).unwrap_or(0).max(0) as u64)
    }

    async fn execute(&self, sql_text: &str, opts: &QueryOpts) -> Result<Materialized, IpcError> {
        let limit = opts.limit.unwrap_or(DEFAULT_LIMIT) as usize;
        let mut conn = self.pool.acquire().await.map_err(db_error)?;
        let id_row = sqlx::query("SELECT CONNECTION_ID()").fetch_one(&mut *conn).await.map_err(db_error)?;
        let conn_id = cell_str(&id_row, 0).and_then(|s| s.parse::<u64>().ok());
        self.set_conn(conn_id);
        let wrap = opts.read_only;

        let result = with_timeout(opts.timeout_ms, async {
            if wrap {
                sqlx::raw_sql("START TRANSACTION READ ONLY").execute(&mut *conn).await.map_err(db_error)?;
            }
            let r = fetch_limited::<sqlx::MySql, Vec<Cell>, _, _>(
                DriverKind::Mysql,
                &mut conn,
                sql_text,
                limit,
                |row| (0..row.len()).map(|i| decode_mysql(row, i)).collect(),
                |qr| qr.rows_affected(),
            )
            .await;
            if wrap {
                let end = if r.is_ok() { "COMMIT" } else { "ROLLBACK" };
                let _ = sqlx::raw_sql(end).execute(&mut *conn).await;
            }
            r.map_err(db_error)
        })
        .await;
        self.set_conn(None);

        match result {
            Ok(f) => Ok(Materialized { columns: f.columns, rows: f.rows, truncated: f.truncated, rows_affected: f.rows_affected }),
            Err(e) => {
                if is_timeout(&e) {
                    if let Some(id) = conn_id {
                        let _ = sqlx::raw_sql(sqlx::AssertSqlSafe(format!("KILL QUERY {id}"))).execute(&self.pool).await;
                    }
                    conn.close_on_drop();
                }
                Err(e)
            }
        }
    }

    async fn cancel(&self) -> Result<(), IpcError> {
        let id = *self.current_conn.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(id) = id {
            sqlx::raw_sql(sqlx::AssertSqlSafe(format!("KILL QUERY {id}"))).execute(&self.pool).await.map_err(db_error)?;
        }
        Ok(())
    }

    fn quote_ident(&self, ident: &str) -> String {
        sql::quote_ident(DriverKind::Mysql, ident)
    }

    fn build_table_select(&self, table: &TableRef, schema: &TableSchema, query: &TableQuery) -> String {
        sql::build_table_select(DriverKind::Mysql, table, schema, query)
    }

    fn render_changes(&self, schema: &TableSchema, changes: &ChangeSet) -> Result<Vec<String>, IpcError> {
        sql::render_changes(DriverKind::Mysql, schema, changes)
    }

    async fn apply(&self, statements: &[String]) -> Result<u64, IpcError> {
        let r: Result<u64, sqlx::Error> = async { apply_in_transaction!(self.pool, statements) }.await;
        r.map_err(db_error)
    }

    async fn close(&self) {
        self.pool.close().await;
    }
}

impl std::fmt::Debug for MysqlDriver {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MysqlDriver").field("database", &self.database).field("tls", &self.tls).finish()
    }
}
