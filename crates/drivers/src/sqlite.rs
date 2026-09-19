//! SQLite driver. One schema (`main`), one database (the file). Row estimates
//! come from `sqlite_stat1` when the user has run `ANALYZE`, otherwise `None`.

use crate::exec::{apply_in_transaction, fetch_limited, with_timeout, DEFAULT_LIMIT};
use crate::sql;
use crate::value::{decode_sqlite_raw, finalize_sqlite, SqliteRaw};
use async_trait::async_trait;
use plinth_core::*;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions};
use sqlx::Row;
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::time::Duration;

pub struct SqliteDriver {
    pool: SqlitePool,
    path: PathBuf,
    read_only: bool,
}

impl SqliteDriver {
    pub async fn connect(path: &str, read_only: bool) -> Result<Self, IpcError> {
        let path_buf = PathBuf::from(path);
        let opts = SqliteConnectOptions::new()
            .filename(&path_buf)
            .read_only(read_only)
            .create_if_missing(!read_only)
            .busy_timeout(Duration::from_secs(5));
        let pool = SqlitePoolOptions::new()
            .max_connections(4)
            .acquire_timeout(Duration::from_secs(10))
            .connect_with(opts)
            .await?;
        Ok(Self { pool, path: path_buf, read_only })
    }

    pub fn pool(&self) -> &SqlitePool {
        &self.pool
    }

    fn file_stem(&self) -> String {
        self.path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| self.path.to_string_lossy().into_owned())
    }

    /// `sqlite_stat1` row counts per table, if the table exists.
    async fn stat1_estimates(&self) -> Result<BTreeMap<String, i64>, IpcError> {
        let exists: Option<(String,)> = sqlx::query_as("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_stat1'")
            .fetch_optional(&self.pool)
            .await?;
        let mut out = BTreeMap::new();
        if exists.is_none() {
            return Ok(out);
        }
        let rows: Vec<(String, Option<String>)> = sqlx::query_as("SELECT tbl, stat FROM sqlite_stat1").fetch_all(&self.pool).await?;
        for (tbl, stat) in rows {
            if let Some(n) = stat.as_deref().and_then(|s| s.split_whitespace().next()).and_then(|s| s.parse::<i64>().ok()) {
                out.entry(tbl).or_insert(n);
            }
        }
        Ok(out)
    }

    /// Declared `(type, nullable)` per column of a table, from `PRAGMA table_info`.
    async fn declared_types(&self, table: &str) -> Result<HashMap<String, (String, bool)>, IpcError> {
        let rows: Vec<(String, Option<String>, i64, i64)> =
            sqlx::query_as("SELECT name, type, \"notnull\", pk FROM pragma_table_info(?1)").bind(table).fetch_all(&self.pool).await?;
        Ok(rows
            .into_iter()
            .map(|(name, ty, notnull, pk)| (name, (ty.unwrap_or_default(), notnull == 0 && pk == 0)))
            .collect())
    }

    /// Result-set columns that come straight from a table take that column's
    /// declared type: sqlx only knows SQLite's storage classes, and a
    /// `NUMERIC`/`DECIMAL`/`JSON` declaration decides the wire encoding.
    async fn apply_declared_types(
        &self,
        mut columns: Vec<ColumnDesc>,
        origins: &[Option<(String, String)>],
    ) -> Result<Vec<ColumnDesc>, IpcError> {
        let mut cache: HashMap<String, HashMap<String, (String, bool)>> = HashMap::new();
        for (col, origin) in columns.iter_mut().zip(origins) {
            let Some((table, name)) = origin else { continue };
            let table = table.rsplit('.').next().unwrap_or(table).to_string();
            if !cache.contains_key(&table) {
                let declared = self.declared_types(&table).await?;
                cache.insert(table.clone(), declared);
            }
            let Some((ty, nullable)) = cache.get(&table).and_then(|m| m.get(name)) else { continue };
            col.nullable = Some(*nullable);
            if !ty.is_empty() {
                col.data_type = ty.to_ascii_uppercase();
                col.logical = logical_type_for(DriverKind::Sqlite, ty);
                col.wire = col.logical.wire();
            }
        }
        Ok(columns)
    }

    async fn object_kind(&self, name: &str) -> Result<Option<ObjectKind>, IpcError> {
        let row: Option<(String,)> = sqlx::query_as("SELECT type FROM sqlite_master WHERE name = ?1 AND type IN ('table', 'view')")
            .bind(name)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.map(|(t,)| if t == "view" { ObjectKind::View } else { ObjectKind::Table }))
    }
}

#[async_trait]
impl Driver for SqliteDriver {
    fn kind(&self) -> DriverKind {
        DriverKind::Sqlite
    }

    async fn server_version(&self) -> Result<String, IpcError> {
        let (v,): (String,) = sqlx::query_as("SELECT sqlite_version()").fetch_one(&self.pool).await?;
        Ok(format!("SQLite {v}"))
    }

    fn tls(&self) -> bool {
        false
    }

    async fn ping(&self) -> Result<(), IpcError> {
        sqlx::query("SELECT 1").execute(&self.pool).await?;
        Ok(())
    }

    async fn list_databases(&self) -> Result<Vec<String>, IpcError> {
        Ok(vec![self.file_stem()])
    }

    fn current_database(&self) -> String {
        self.file_stem()
    }

    async fn schema_index(&self) -> Result<SchemaIndex, IpcError> {
        let estimates = self.stat1_estimates().await?;
        let objs: Vec<(String, String)> = sqlx::query_as(
            "SELECT type, name FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name",
        )
        .fetch_all(&self.pool)
        .await?;
        let objects: Vec<ObjectInfo> = objs
            .into_iter()
            .map(|(t, name)| {
                let kind = if t == "view" { ObjectKind::View } else { ObjectKind::Table };
                let row_estimate = if kind == ObjectKind::Table { estimates.get(&name).copied() } else { None };
                ObjectInfo { schema: "main".into(), name, kind, row_estimate }
            })
            .collect();

        let cols: Vec<(String, String)> = sqlx::query_as(
            "SELECT m.name, p.name FROM sqlite_master m JOIN pragma_table_info(m.name) p \
             WHERE m.type IN ('table', 'view') AND m.name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY m.name, p.cid",
        )
        .fetch_all(&self.pool)
        .await?;
        let columns = cols.into_iter().map(|(table, column)| ColumnRef { schema: "main".into(), table, column }).collect();

        Ok(SchemaIndex {
            schemas: vec![SchemaInfo { name: "main".into(), is_system: false, objects }],
            columns,
            generated_at: chrono::Utc::now().to_rfc3339(),
        })
    }

    async fn describe_table(&self, table: &TableRef) -> Result<TableSchema, IpcError> {
        let name = table.name.as_str();
        let kind = self.object_kind(name).await?.ok_or_else(|| IpcError::not_found(format!("table {name} not found")))?;

        let col_rows = sqlx::query(
            "SELECT cid, name, type, \"notnull\", dflt_value, pk FROM pragma_table_info(?1) ORDER BY cid",
        )
        .bind(name)
        .fetch_all(&self.pool)
        .await?;
        let mut columns = Vec::with_capacity(col_rows.len());
        let mut pk_positions: Vec<(i64, String)> = Vec::new();
        for r in &col_rows {
            let cid: i64 = r.try_get("cid")?;
            let cname: String = r.try_get("name")?;
            let data_type: String = r.try_get::<Option<String>, _>("type")?.unwrap_or_default();
            let notnull: i64 = r.try_get("notnull")?;
            let default: Option<String> = r.try_get("dflt_value")?;
            let pk: i64 = r.try_get("pk")?;
            if pk > 0 {
                pk_positions.push((pk, cname.clone()));
            }
            columns.push(ColumnInfo {
                logical: logical_type_for(DriverKind::Sqlite, &data_type),
                name: cname,
                data_type,
                nullable: notnull == 0 && pk == 0,
                default,
                is_primary_key: pk > 0,
                ordinal: cid as u32,
            });
        }
        pk_positions.sort();
        let primary_key: Vec<String> = pk_positions.into_iter().map(|(_, n)| n).collect();

        let fk_rows = sqlx::query("SELECT id, seq, \"table\", \"from\", \"to\" FROM pragma_foreign_key_list(?1) ORDER BY id, seq")
            .bind(name)
            .fetch_all(&self.pool)
            .await?;
        let mut fks: Vec<(i64, ForeignKey)> = Vec::new();
        for r in &fk_rows {
            let id: i64 = r.try_get("id")?;
            let ref_table: String = r.try_get("table")?;
            let from: String = r.try_get("from")?;
            let to: Option<String> = r.try_get("to")?;
            match fks.iter_mut().find(|(i, _)| *i == id) {
                Some((_, fk)) => {
                    fk.columns.push(from);
                    if let Some(t) = to {
                        fk.ref_columns.push(t);
                    }
                }
                None => fks.push((
                    id,
                    ForeignKey {
                        name: None,
                        columns: vec![from],
                        ref_table: TableRef { schema: Some("main".into()), name: ref_table },
                        ref_columns: to.into_iter().collect(),
                    },
                )),
            }
        }
        let foreign_keys = fks.into_iter().map(|(_, fk)| fk).collect();

        let idx_rows = sqlx::query("SELECT name, \"unique\", origin FROM pragma_index_list(?1) ORDER BY seq")
            .bind(name)
            .fetch_all(&self.pool)
            .await?;
        let mut indexes = Vec::with_capacity(idx_rows.len());
        for r in &idx_rows {
            let iname: String = r.try_get("name")?;
            let unique: i64 = r.try_get("unique")?;
            let origin: String = r.try_get("origin")?;
            let cols: Vec<(Option<String>,)> = sqlx::query_as("SELECT name FROM pragma_index_info(?1) ORDER BY seqno")
                .bind(&iname)
                .fetch_all(&self.pool)
                .await?;
            indexes.push(IndexInfo {
                name: iname,
                columns: cols.into_iter().map(|(c,)| c.unwrap_or_else(|| "<expression>".into())).collect(),
                unique: unique != 0,
                primary: origin == "pk",
            });
        }
        // A rowid-table with INTEGER PRIMARY KEY has no separate index; surface it anyway.
        if !primary_key.is_empty() && !indexes.iter().any(|i| i.primary) {
            indexes.insert(0, IndexInfo { name: "PRIMARY KEY".into(), columns: primary_key.clone(), unique: true, primary: true });
        }

        let ddl: Option<(Option<String>,)> = sqlx::query_as("SELECT sql FROM sqlite_master WHERE name = ?1 AND type IN ('table', 'view')")
            .bind(name)
            .fetch_optional(&self.pool)
            .await?;
        let row_estimate = self.stat1_estimates().await?.get(name).copied();

        Ok(TableSchema {
            table: TableRef { schema: Some("main".into()), name: name.to_string() },
            kind,
            columns,
            primary_key,
            foreign_keys,
            indexes,
            ddl: ddl.and_then(|(s,)| s),
            row_estimate,
        })
    }

    async fn schema_snapshot(&self) -> Result<SchemaSnapshot, IpcError> {
        // Table-valued pragmas again: one pass for columns, one for indexes.
        let col_rows = sqlx::query(
            "SELECT m.name AS tbl, m.type AS kind, p.name AS col, p.type AS ty, p.\"notnull\" AS notnull, \
                    p.dflt_value AS dflt, p.cid AS ordinal, p.pk AS pk \
             FROM sqlite_master m JOIN pragma_table_info(m.name) p \
             WHERE m.type IN ('table', 'view') AND m.name NOT LIKE 'sqlite_%' \
             ORDER BY m.name, p.cid",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(IpcError::from)?;

        let idx_rows = sqlx::query(
            "SELECT m.name AS tbl, i.name AS idx, i.\"unique\" AS uniq, \
                    (SELECT group_concat(ii.name) FROM pragma_index_info(i.name) ii) AS cols \
             FROM sqlite_master m JOIN pragma_index_list(m.name) i \
             WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' \
             ORDER BY m.name, i.name",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(IpcError::from)?;

        let mut tables: Vec<TableSnapshot> = Vec::new();
        let mut at: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        for r in &col_rows {
            let name: String = r.try_get("tbl")?;
            let kind = if r.try_get::<String, _>("kind")? == "view" { ObjectKind::View } else { ObjectKind::Table };
            let index = *at.entry(name.clone()).or_insert_with(|| {
                tables.push(TableSnapshot {
                    table: TableRef { schema: None, name: name.clone() },
                    kind,
                    columns: Vec::new(),
                    primary_key: Vec::new(),
                    indexes: Vec::new(),
                });
                tables.len() - 1
            });
            let column: String = r.try_get("col")?;
            if r.try_get::<i64, _>("pk").unwrap_or(0) > 0 {
                tables[index].primary_key.push(column.clone());
            }
            tables[index].columns.push(ColumnSnapshot {
                name: column,
                data_type: r.try_get::<Option<String>, _>("ty")?.unwrap_or_default(),
                nullable: r.try_get::<i64, _>("notnull").unwrap_or(0) == 0,
                default: r.try_get::<Option<String>, _>("dflt")?,
                ordinal: r.try_get::<i64, _>("ordinal").unwrap_or(0) as i32,
            });
        }
        for r in &idx_rows {
            let Some(&i) = at.get(&r.try_get::<String, _>("tbl")?) else { continue };
            let name: String = r.try_get("idx")?;
            let unique = r.try_get::<i64, _>("uniq").unwrap_or(0) == 1;
            let cols: Option<String> = r.try_get("cols")?;
            tables[i].indexes.push(IndexSnapshot {
                definition: format!("{} INDEX {name} ({})", if unique { "UNIQUE" } else { "" }, cols.unwrap_or_default()).trim().to_string(),
                name,
                unique,
            });
        }

        Ok(SchemaSnapshot { tables, foreign_keys: self.foreign_keys().await?, generated_at: plinth_core::store::now_rfc3339() })
    }

    async fn foreign_keys(&self) -> Result<Vec<GraphEdge>, IpcError> {
        // `pragma_foreign_key_list` as a table-valued function: one pass over
        // every table rather than a PRAGMA per table.
        let rows = sqlx::query(
            "SELECT m.name AS from_table, f.id AS fk_id, f.seq AS seq, \
                    f.\"table\" AS to_table, f.\"from\" AS from_col, f.\"to\" AS to_col \
             FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) f \
             WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' \
             ORDER BY m.name, f.id, f.seq",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(IpcError::from)?;

        let mut out: Vec<GraphEdge> = Vec::new();
        let mut current: Option<(String, i64)> = None;
        for r in &rows {
            let from_table: String = r.try_get("from_table")?;
            let fk_id: i64 = r.try_get("fk_id")?;
            let to_table: String = r.try_get("to_table")?;
            let from_col: Option<String> = r.try_get("from_col")?;
            // A null `to` means "the referenced table's primary key".
            let to_col: Option<String> = r.try_get("to_col")?;
            let key = (from_table.clone(), fk_id);
            if current.as_ref() == Some(&key) {
                if let Some(e) = out.last_mut() {
                    e.from_columns.push(from_col.unwrap_or_default());
                    e.to_columns.push(to_col.unwrap_or_else(|| "rowid".into()));
                }
            } else {
                out.push(GraphEdge {
                    from: TableRef { schema: None, name: from_table },
                    from_columns: vec![from_col.unwrap_or_default()],
                    to: TableRef { schema: None, name: to_table },
                    to_columns: vec![to_col.unwrap_or_else(|| "rowid".into())],
                    name: None,
                    inferred: false,
                });
                current = Some(key);
            }
        }
        Ok(out)
    }

    async fn count(&self, table: &TableRef, exact: bool) -> Result<u64, IpcError> {
        if !exact {
            if let Some(n) = self.stat1_estimates().await?.get(&table.name) {
                return Ok((*n).max(0) as u64);
            }
        }
        let sql = format!("SELECT COUNT(*) FROM {}", self.quote_table(table));
        let (n,): (i64,) = sqlx::query_as(sqlx::AssertSqlSafe(sql)).fetch_one(&self.pool).await?;
        Ok(n.max(0) as u64)
    }

    async fn execute(&self, sql: &str, opts: &QueryOpts) -> Result<Materialized, IpcError> {
        let limit = opts.limit.unwrap_or(DEFAULT_LIMIT) as usize;
        let mut conn = self.pool.acquire().await?;
        let guard_read_only = opts.read_only && !self.read_only;

        let result = with_timeout(opts.timeout_ms, async {
            if guard_read_only {
                sqlx::raw_sql("PRAGMA query_only = 1").execute(&mut *conn).await?;
            }
            let fetched = fetch_limited::<sqlx::Sqlite, Vec<SqliteRaw>, _, _>(
                DriverKind::Sqlite,
                &mut conn,
                sql,
                limit,
                |row| (0..row.len()).map(|i| decode_sqlite_raw(row, i)).collect(),
                |qr| qr.rows_affected(),
            )
            .await;
            if guard_read_only {
                let _ = sqlx::raw_sql("PRAGMA query_only = 0").execute(&mut *conn).await;
            }
            fetched.map_err(IpcError::from)
        })
        .await;

        let fetched = match result {
            Ok(f) => f,
            Err(e) => {
                // A timed-out statement may still be stepping on the worker thread;
                // do not hand that connection back to the pool.
                conn.close_on_drop();
                return Err(e);
            }
        };
        let columns = self.apply_declared_types(fetched.columns, &fetched.origins).await?;
        let (columns, rows) = finalize_sqlite(columns, fetched.rows);
        Ok(Materialized { columns, rows, truncated: fetched.truncated, rows_affected: fetched.rows_affected })
    }

    async fn cancel(&self) -> Result<(), IpcError> {
        // sqlx does not expose sqlite3_interrupt; dropping the fetch stream stops stepping.
        Ok(())
    }

    fn quote_ident(&self, ident: &str) -> String {
        sql::quote_ident(DriverKind::Sqlite, ident)
    }

    fn build_table_select(&self, table: &TableRef, schema: &TableSchema, query: &TableQuery) -> String {
        sql::build_table_select(DriverKind::Sqlite, table, schema, query)
    }

    fn render_changes(&self, schema: &TableSchema, changes: &ChangeSet) -> Result<Vec<String>, IpcError> {
        sql::render_changes(DriverKind::Sqlite, schema, changes)
    }

    async fn apply(&self, statements: &[String]) -> Result<u64, IpcError> {
        apply_in_transaction!(self.pool, statements)
    }

    async fn close(&self) {
        self.pool.close().await;
    }
}

impl std::fmt::Debug for SqliteDriver {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SqliteDriver").field("path", &self.path).field("read_only", &self.read_only).finish()
    }
}
