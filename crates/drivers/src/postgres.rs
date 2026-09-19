//! PostgreSQL driver. Introspection reads `pg_catalog` directly; row
//! estimates are `pg_class.reltuples`; cancellation goes through
//! `pg_cancel_backend` on a second pooled connection.

use crate::exec::{apply_in_transaction, db_error, fetch_limited, is_timeout, with_timeout, DEFAULT_LIMIT};
use crate::sql;
use crate::value::decode_pg;
use async_trait::async_trait;
use plinth_core::*;
use sqlx::postgres::{PgConnectOptions, PgPool, PgPoolOptions, PgSslMode};
use sqlx::Row;
use std::sync::Mutex;
use std::time::Duration;

pub struct PostgresDriver {
    pool: PgPool,
    database: String,
    tls: bool,
    /// Backend pid of the connection running the current `execute`.
    current_pid: Mutex<Option<i32>>,
}

impl PostgresDriver {
    pub async fn connect(opts: PgConnectOptions, read_only: bool, limits: SessionLimits) -> Result<Self, IpcError> {
        let mut pool_opts = PgPoolOptions::new().max_connections(4).acquire_timeout(Duration::from_secs(10));
        // Every pooled connection is set up the same way: a query can be served
        // by any of them, so the limits have to be per-connection, not per-query.
        let timeout_ms = limits.statement_timeout_ms;
        if read_only || timeout_ms.is_some() {
            pool_opts = pool_opts.after_connect(move |conn, _meta| {
                Box::pin(async move {
                    if read_only {
                        sqlx::raw_sql("SET default_transaction_read_only = on").execute(&mut *conn).await?;
                    }
                    if let Some(ms) = timeout_ms {
                        sqlx::raw_sql(sqlx::AssertSqlSafe(format!("SET statement_timeout = {ms}"))).execute(&mut *conn).await?;
                    }
                    Ok(())
                })
            });
        }
        let ssl_required = matches!(opts.get_ssl_mode(), PgSslMode::Require | PgSslMode::VerifyCa | PgSslMode::VerifyFull);
        let pool = pool_opts.connect_with(opts).await.map_err(db_error)?;

        let (database,): (String,) = sqlx::query_as("SELECT current_database()").fetch_one(&pool).await.map_err(db_error)?;
        let tls = match sqlx::query_as::<_, (Option<bool>,)>("SELECT ssl FROM pg_catalog.pg_stat_ssl WHERE pid = pg_backend_pid()")
            .fetch_optional(&pool)
            .await
        {
            Ok(Some((Some(ssl),))) => ssl,
            _ => ssl_required,
        };
        Ok(Self { pool, database, tls, current_pid: Mutex::new(None) })
    }

    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    fn set_pid(&self, pid: Option<i32>) {
        let mut guard = self.current_pid.lock().unwrap_or_else(|p| p.into_inner());
        *guard = pid;
    }

    fn schema_of<'a>(&self, table: &'a TableRef) -> &'a str {
        table.schema.as_deref().filter(|s| !s.is_empty()).unwrap_or("public")
    }

    /// `(oid, relkind, reltuples)` for a table, or not-found.
    async fn relation(&self, table: &TableRef) -> Result<(sqlx::postgres::types::Oid, String, f64), IpcError> {
        let row = sqlx::query(
            "SELECT c.oid, c.relkind::text AS relkind, c.reltuples::float8 AS reltuples \
             FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
             WHERE n.nspname = $1 AND c.relname = $2",
        )
        .bind(self.schema_of(table))
        .bind(&table.name)
        .fetch_optional(&self.pool)
        .await
        .map_err(db_error)?
        .ok_or_else(|| IpcError::not_found(format!("table {}.{} not found", self.schema_of(table), table.name)))?;
        Ok((row.try_get("oid")?, row.try_get("relkind")?, row.try_get("reltuples")?))
    }
}

fn estimate(reltuples: f64) -> Option<i64> {
    if reltuples < 0.0 {
        None
    } else {
        Some(reltuples.round() as i64)
    }
}

fn kind_of(relkind: &str) -> ObjectKind {
    match relkind {
        "v" => ObjectKind::View,
        "m" => ObjectKind::MaterializedView,
        "S" => ObjectKind::Sequence,
        _ => ObjectKind::Table,
    }
}

#[async_trait]
impl Driver for PostgresDriver {
    fn kind(&self) -> DriverKind {
        DriverKind::Postgres
    }

    async fn server_version(&self) -> Result<String, IpcError> {
        let (v,): (String,) = sqlx::query_as("SHOW server_version").fetch_one(&self.pool).await.map_err(db_error)?;
        let short = v.split_whitespace().next().unwrap_or(&v);
        Ok(format!("PostgreSQL {short}"))
    }

    fn tls(&self) -> bool {
        self.tls
    }

    async fn ping(&self) -> Result<(), IpcError> {
        sqlx::query("SELECT 1").execute(&self.pool).await.map_err(db_error)?;
        Ok(())
    }

    async fn list_databases(&self) -> Result<Vec<String>, IpcError> {
        let rows: Vec<(String,)> =
            sqlx::query_as("SELECT datname FROM pg_catalog.pg_database WHERE NOT datistemplate AND datallowconn ORDER BY datname")
                .fetch_all(&self.pool)
                .await
                .map_err(db_error)?;
        Ok(rows.into_iter().map(|(n,)| n).collect())
    }

    fn current_database(&self) -> String {
        self.database.clone()
    }

    async fn schema_index(&self) -> Result<SchemaIndex, IpcError> {
        let schema_rows: Vec<(String,)> = sqlx::query_as(
            "SELECT nspname FROM pg_catalog.pg_namespace \
             WHERE nspname NOT LIKE 'pg\\_toast%' AND nspname NOT LIKE 'pg\\_temp%' ORDER BY nspname",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(db_error)?;

        let rel_rows: Vec<(String, String, String, f64)> = sqlx::query_as(
            "SELECT n.nspname, c.relname, c.relkind::text, c.reltuples::float8 \
             FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
             WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S') \
               AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%' \
             ORDER BY n.nspname, c.relname",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(db_error)?;

        let fn_rows: Vec<(String, String)> = sqlx::query_as(
            "SELECT DISTINCT n.nspname, p.proname \
             FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace \
             WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%' \
             ORDER BY n.nspname, p.proname",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(db_error)?;

        let col_rows: Vec<(String, String, String)> = sqlx::query_as(
            "SELECT n.nspname, c.relname, a.attname \
             FROM pg_catalog.pg_attribute a \
             JOIN pg_catalog.pg_class c ON c.oid = a.attrelid \
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
             WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r', 'p', 'v', 'm', 'f') \
               AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%' \
             ORDER BY n.nspname, c.relname, a.attnum",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(db_error)?;

        let mut schemas: Vec<SchemaInfo> = schema_rows
            .into_iter()
            .map(|(name,)| SchemaInfo { is_system: name == "pg_catalog" || name == "information_schema", name, objects: Vec::new() })
            .collect();
        for (schema, name, relkind, reltuples) in rel_rows {
            if let Some(s) = schemas.iter_mut().find(|s| s.name == schema) {
                let kind = kind_of(&relkind);
                let row_estimate = if kind == ObjectKind::Table || kind == ObjectKind::MaterializedView { estimate(reltuples) } else { None };
                s.objects.push(ObjectInfo { schema, name, kind, row_estimate });
            }
        }
        for (schema, name) in fn_rows {
            if let Some(s) = schemas.iter_mut().find(|s| s.name == schema) {
                s.objects.push(ObjectInfo { schema, name, kind: ObjectKind::Function, row_estimate: None });
            }
        }
        let columns = col_rows.into_iter().map(|(schema, table, column)| ColumnRef { schema, table, column }).collect();
        Ok(SchemaIndex { schemas, columns, generated_at: chrono::Utc::now().to_rfc3339() })
    }

    async fn describe_table(&self, table: &TableRef) -> Result<TableSchema, IpcError> {
        let schema_name = self.schema_of(table).to_string();
        let (oid, relkind, reltuples) = self.relation(table).await?;
        let kind = kind_of(&relkind);

        let col_rows = sqlx::query(
            "SELECT a.attnum, a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type, a.attnotnull, \
                    pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS default_expr, a.attidentity::text AS identity \
             FROM pg_catalog.pg_attribute a \
             LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum \
             WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum",
        )
        .bind(oid)
        .fetch_all(&self.pool)
        .await
        .map_err(db_error)?;

        let pk_rows: Vec<(String,)> = sqlx::query_as(
            "SELECT a.attname::text FROM pg_catalog.pg_index i \
             JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey::int2[]) \
             WHERE i.indrelid = $1 AND i.indisprimary \
             ORDER BY array_position(i.indkey::int2[], a.attnum)",
        )
        .bind(oid)
        .fetch_all(&self.pool)
        .await
        .map_err(db_error)?;
        let primary_key: Vec<String> = pk_rows.into_iter().map(|(n,)| n).collect();

        let mut columns = Vec::with_capacity(col_rows.len());
        for r in &col_rows {
            let attnum: i16 = r.try_get("attnum")?;
            let name: String = r.try_get("attname")?;
            let data_type: String = r.try_get("data_type")?;
            let notnull: bool = r.try_get("attnotnull")?;
            let default: Option<String> = r.try_get("default_expr")?;
            let identity: String = r.try_get("identity")?;
            let default = default.or_else(|| match identity.as_str() {
                "a" => Some("GENERATED ALWAYS AS IDENTITY".into()),
                "d" => Some("GENERATED BY DEFAULT AS IDENTITY".into()),
                _ => None,
            });
            columns.push(ColumnInfo {
                logical: logical_type_for(DriverKind::Postgres, &data_type),
                is_primary_key: primary_key.contains(&name),
                name,
                data_type,
                nullable: !notnull,
                default,
                ordinal: attnum.max(0) as u32,
            });
        }

        let fk_rows = sqlx::query(
            "SELECT con.conname::text AS name, nr.nspname::text AS ref_schema, cr.relname::text AS ref_table, \
               (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord) \
                  JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS cols, \
               (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord) \
                  JOIN pg_catalog.pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum) AS ref_cols \
             FROM pg_catalog.pg_constraint con \
             JOIN pg_catalog.pg_class cr ON cr.oid = con.confrelid \
             JOIN pg_catalog.pg_namespace nr ON nr.oid = cr.relnamespace \
             WHERE con.conrelid = $1 AND con.contype = 'f' ORDER BY con.conname",
        )
        .bind(oid)
        .fetch_all(&self.pool)
        .await
        .map_err(db_error)?;
        let mut foreign_keys = Vec::with_capacity(fk_rows.len());
        for r in &fk_rows {
            foreign_keys.push(ForeignKey {
                name: Some(r.try_get::<String, _>("name")?),
                columns: r.try_get::<Option<Vec<String>>, _>("cols")?.unwrap_or_default(),
                ref_table: TableRef { schema: Some(r.try_get("ref_schema")?), name: r.try_get("ref_table")? },
                ref_columns: r.try_get::<Option<Vec<String>>, _>("ref_cols")?.unwrap_or_default(),
            });
        }

        let idx_rows = sqlx::query(
            "SELECT ic.relname::text AS name, i.indisunique, i.indisprimary, \
               (SELECT array_agg(pg_catalog.pg_get_indexdef(i.indexrelid, k.ord::int, true) ORDER BY k.ord) \
                  FROM unnest(i.indkey::int2[]) WITH ORDINALITY k(attnum, ord)) AS cols, \
               pg_catalog.pg_get_indexdef(i.indexrelid) AS def \
             FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid \
             WHERE i.indrelid = $1 ORDER BY i.indisprimary DESC, ic.relname",
        )
        .bind(oid)
        .fetch_all(&self.pool)
        .await
        .map_err(db_error)?;
        let mut indexes = Vec::with_capacity(idx_rows.len());
        let mut index_defs = Vec::new();
        for r in &idx_rows {
            let primary: bool = r.try_get("indisprimary")?;
            if !primary {
                index_defs.push(r.try_get::<String, _>("def")?);
            }
            indexes.push(IndexInfo {
                name: r.try_get("name")?,
                columns: r.try_get::<Option<Vec<String>>, _>("cols")?.unwrap_or_default(),
                unique: r.try_get("indisunique")?,
                primary,
            });
        }

        let table_ref = TableRef { schema: Some(schema_name), name: table.name.clone() };
        let ddl = match kind {
            ObjectKind::View | ObjectKind::MaterializedView => {
                let (def,): (String,) = sqlx::query_as("SELECT pg_catalog.pg_get_viewdef($1, true)")
                    .bind(oid)
                    .fetch_one(&self.pool)
                    .await
                    .map_err(db_error)?;
                let what = if kind == ObjectKind::View { "VIEW" } else { "MATERIALIZED VIEW" };
                Some(format!("CREATE {what} {} AS\n{}", self.quote_table(&table_ref), def.trim_end()))
            }
            ObjectKind::Table => Some(self.render_create_table(&table_ref, &columns, &primary_key, &foreign_keys, &index_defs)),
            _ => None,
        };

        Ok(TableSchema { table: table_ref, kind, columns, primary_key, foreign_keys, indexes, ddl, row_estimate: estimate(reltuples) })
    }

    async fn schema_snapshot(&self) -> Result<SchemaSnapshot, IpcError> {
        // pg_catalog rather than information_schema: `format_type` gives the
        // type exactly as the server spells it, modifiers and all, which is
        // what makes `varchar(50)` vs `varchar(80)` a real difference.
        const USER_SCHEMAS: &str = "n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_toast%'";

        let col_rows = sqlx::query(sqlx::AssertSqlSafe(format!(
            "SELECT n.nspname::text AS schema, c.relname::text AS table, c.relkind::text AS kind, \
                    a.attname::text AS column, pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type, \
                    (NOT a.attnotnull) AS nullable, pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS default_expr, \
                    a.attnum::int AS ordinal \
             FROM pg_catalog.pg_attribute a \
             JOIN pg_catalog.pg_class c ON c.oid = a.attrelid \
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
             LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum \
             WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r', 'v', 'm', 'p') AND {USER_SCHEMAS} \
             ORDER BY n.nspname, c.relname, a.attnum"
        )))
        .fetch_all(&self.pool)
        .await
        .map_err(db_error)?;

        let pk_rows = sqlx::query(sqlx::AssertSqlSafe(format!(
            "SELECT n.nspname::text AS schema, c.relname::text AS table, a.attname::text AS column \
             FROM pg_catalog.pg_constraint con \
             JOIN pg_catalog.pg_class c ON c.oid = con.conrelid \
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
             JOIN unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON true \
             JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum \
             WHERE con.contype = 'p' AND {USER_SCHEMAS} \
             ORDER BY n.nspname, c.relname, k.ord"
        )))
        .fetch_all(&self.pool)
        .await
        .map_err(db_error)?;

        let idx_rows = sqlx::query(
            "SELECT schemaname::text AS schema, tablename::text AS table, indexname::text AS name, indexdef::text AS def \
             FROM pg_catalog.pg_indexes \
             WHERE schemaname NOT IN ('pg_catalog', 'information_schema') \
             ORDER BY schemaname, tablename, indexname",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(db_error)?;

        // Rows arrive ordered by (schema, table, attnum), so the Vec keeps
        // catalogue order while the map gives O(1) lookup — no extra crate.
        let mut tables: Vec<TableSnapshot> = Vec::new();
        let mut at: std::collections::HashMap<(String, String), usize> = std::collections::HashMap::new();
        for r in &col_rows {
            let schema: String = r.try_get("schema")?;
            let name: String = r.try_get("table")?;
            let kind = match r.try_get::<String, _>("kind")?.as_str() {
                "v" => ObjectKind::View,
                "m" => ObjectKind::MaterializedView,
                _ => ObjectKind::Table,
            };
            let index = *at.entry((schema.clone(), name.clone())).or_insert_with(|| {
                tables.push(TableSnapshot {
                    table: TableRef { schema: Some(schema.clone()), name: name.clone() },
                    kind,
                    columns: Vec::new(),
                    primary_key: Vec::new(),
                    indexes: Vec::new(),
                });
                tables.len() - 1
            });
            tables[index].columns.push(ColumnSnapshot {
                name: r.try_get("column")?,
                data_type: r.try_get("data_type")?,
                nullable: r.try_get("nullable")?,
                default: r.try_get("default_expr")?,
                ordinal: r.try_get("ordinal")?,
            });
        }
        for r in &pk_rows {
            if let Some(&i) = at.get(&(r.try_get("schema")?, r.try_get("table")?)) {
                tables[i].primary_key.push(r.try_get("column")?);
            }
        }
        for r in &idx_rows {
            if let Some(&i) = at.get(&(r.try_get("schema")?, r.try_get("table")?)) {
                let def: String = r.try_get("def")?;
                tables[i].indexes.push(IndexSnapshot { name: r.try_get("name")?, unique: def.to_ascii_uppercase().contains("CREATE UNIQUE"), definition: def });
            }
        }

        Ok(SchemaSnapshot { tables, foreign_keys: self.foreign_keys().await?, generated_at: plinth_core::store::now_rfc3339() })
    }

    async fn foreign_keys(&self) -> Result<Vec<GraphEdge>, IpcError> {
        let rows = sqlx::query(
            "SELECT con.conname::text AS name, \
                    ns.nspname::text AS from_schema, cl.relname::text AS from_table, \
                    nr.nspname::text AS to_schema, cr.relname::text AS to_table, \
                    (SELECT array_agg(a.attname::text ORDER BY k.ord) \
                       FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) \
                       JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS from_cols, \
                    (SELECT array_agg(a.attname::text ORDER BY k.ord) \
                       FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord) \
                       JOIN pg_catalog.pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum) AS to_cols \
             FROM pg_catalog.pg_constraint con \
             JOIN pg_catalog.pg_class cl ON cl.oid = con.conrelid \
             JOIN pg_catalog.pg_namespace ns ON ns.oid = cl.relnamespace \
             JOIN pg_catalog.pg_class cr ON cr.oid = con.confrelid \
             JOIN pg_catalog.pg_namespace nr ON nr.oid = cr.relnamespace \
             WHERE con.contype = 'f' \
               AND ns.nspname NOT IN ('pg_catalog', 'information_schema') \
               AND ns.nspname NOT LIKE 'pg_toast%' \
             ORDER BY ns.nspname, cl.relname, con.conname",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(db_error)?;

        let mut out = Vec::with_capacity(rows.len());
        for r in &rows {
            out.push(GraphEdge {
                from: TableRef { schema: Some(r.try_get("from_schema")?), name: r.try_get("from_table")? },
                from_columns: r.try_get::<Option<Vec<String>>, _>("from_cols")?.unwrap_or_default(),
                to: TableRef { schema: Some(r.try_get("to_schema")?), name: r.try_get("to_table")? },
                to_columns: r.try_get::<Option<Vec<String>>, _>("to_cols")?.unwrap_or_default(),
                name: Some(r.try_get::<String, _>("name")?),
                inferred: false,
            });
        }
        Ok(out)
    }

    async fn count(&self, table: &TableRef, exact: bool) -> Result<u64, IpcError> {
        if !exact {
            let (_, _, reltuples) = self.relation(table).await?;
            if let Some(n) = estimate(reltuples) {
                return Ok(n.max(0) as u64);
            }
        }
        let sql = format!("SELECT COUNT(*) FROM {}", self.quote_table(table));
        let (n,): (i64,) = sqlx::query_as(sqlx::AssertSqlSafe(sql)).fetch_one(&self.pool).await.map_err(db_error)?;
        Ok(n.max(0) as u64)
    }

    async fn execute(&self, sql_text: &str, opts: &QueryOpts) -> Result<Materialized, IpcError> {
        let limit = opts.limit.unwrap_or(DEFAULT_LIMIT) as usize;
        let mut conn = self.pool.acquire().await.map_err(db_error)?;
        let (pid,): (i32,) = sqlx::query_as("SELECT pg_backend_pid()").fetch_one(&mut *conn).await.map_err(db_error)?;
        self.set_pid(Some(pid));
        let wrap = opts.read_only;

        let result = with_timeout(opts.timeout_ms, async {
            if wrap {
                sqlx::raw_sql("BEGIN READ ONLY").execute(&mut *conn).await.map_err(db_error)?;
            }
            let r = fetch_limited::<sqlx::Postgres, Vec<Cell>, _, _>(
                DriverKind::Postgres,
                &mut conn,
                sql_text,
                limit,
                |row| (0..row.len()).map(|i| decode_pg(row, i)).collect(),
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
        self.set_pid(None);

        match result {
            Ok(f) => Ok(Materialized { columns: f.columns, rows: f.rows, truncated: f.truncated, rows_affected: f.rows_affected }),
            Err(e) => {
                if is_timeout(&e) {
                    let _ = sqlx::query("SELECT pg_cancel_backend($1)").bind(pid).execute(&self.pool).await;
                    conn.close_on_drop();
                }
                Err(e)
            }
        }
    }

    /// One connection, held for the whole sequence: reset, create the
    /// hypothetical indexes, plan, reset. Anything else and the planner never
    /// sees them — see the trait's note.
    async fn explain_hypothetical(&self, sql: &str, indexes: &[String]) -> Result<String, IpcError> {
        use sqlx::Acquire;
        let mut conn = self.pool.acquire().await.map_err(db_error)?;
        let conn = conn.acquire().await.map_err(db_error)?;

        let present: bool = sqlx::query_scalar("SELECT count(*) > 0 FROM pg_extension WHERE extname = 'hypopg'")
            .fetch_one(&mut *conn)
            .await
            .map_err(db_error)?;
        if !present && !indexes.is_empty() {
            return Err(IpcError::invalid(
                "The hypopg extension is not installed on this database, so an index cannot be tested without building it.",
            ));
        }

        if present {
            sqlx::query("SELECT hypopg_reset()").execute(&mut *conn).await.map_err(db_error)?;
        }
        for ddl in indexes {
            sqlx::query("SELECT hypopg_create_index($1)")
                .bind(ddl.trim_end_matches(';'))
                .execute(&mut *conn)
                .await
                .map_err(db_error)?;
        }
        // Plain EXPLAIN only: a hypothetical index is invisible to ANALYZE,
        // which is why this reports estimated cost and says so.
        let plan: serde_json::Value = sqlx::query_scalar(sqlx::AssertSqlSafe(format!("EXPLAIN (FORMAT JSON) {}", sql.trim().trim_end_matches(';'))))
            .fetch_one(&mut *conn)
            .await
            .map_err(db_error)?;
        if present {
            let _ = sqlx::query("SELECT hypopg_reset()").execute(&mut *conn).await;
        }
        Ok(plan.to_string())
    }

    async fn cancel(&self) -> Result<(), IpcError> {
        let pid = *self.current_pid.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(pid) = pid {
            sqlx::query("SELECT pg_cancel_backend($1)").bind(pid).execute(&self.pool).await.map_err(db_error)?;
        }
        Ok(())
    }

    fn quote_ident(&self, ident: &str) -> String {
        sql::quote_ident(DriverKind::Postgres, ident)
    }

    fn build_table_select(&self, table: &TableRef, schema: &TableSchema, query: &TableQuery) -> String {
        sql::build_table_select(DriverKind::Postgres, table, schema, query)
    }

    fn render_changes(&self, schema: &TableSchema, changes: &ChangeSet) -> Result<Vec<String>, IpcError> {
        sql::render_changes(DriverKind::Postgres, schema, changes)
    }

    async fn apply(&self, statements: &[String]) -> Result<u64, IpcError> {
        let r: Result<u64, sqlx::Error> = async { apply_in_transaction!(self.pool, statements) }.await;
        r.map_err(db_error)
    }

    async fn close(&self) {
        self.pool.close().await;
    }
}

impl PostgresDriver {
    fn render_create_table(
        &self,
        table: &TableRef,
        columns: &[ColumnInfo],
        primary_key: &[String],
        foreign_keys: &[ForeignKey],
        index_defs: &[String],
    ) -> String {
        let mut lines: Vec<String> = columns
            .iter()
            .map(|c| {
                let mut l = format!("  {} {}", self.quote_ident(&c.name), c.data_type);
                if !c.nullable {
                    l.push_str(" NOT NULL");
                }
                if let Some(d) = &c.default {
                    if d.starts_with("GENERATED") {
                        l.push(' ');
                        l.push_str(d);
                    } else {
                        l.push_str(" DEFAULT ");
                        l.push_str(d);
                    }
                }
                l
            })
            .collect();
        if !primary_key.is_empty() {
            let cols: Vec<String> = primary_key.iter().map(|c| self.quote_ident(c)).collect();
            lines.push(format!("  PRIMARY KEY ({})", cols.join(", ")));
        }
        for fk in foreign_keys {
            let cols: Vec<String> = fk.columns.iter().map(|c| self.quote_ident(c)).collect();
            let ref_cols: Vec<String> = fk.ref_columns.iter().map(|c| self.quote_ident(c)).collect();
            let name = fk.name.as_deref().map(|n| format!("CONSTRAINT {} ", self.quote_ident(n))).unwrap_or_default();
            lines.push(format!(
                "  {name}FOREIGN KEY ({}) REFERENCES {} ({})",
                cols.join(", "),
                self.quote_table(&fk.ref_table),
                ref_cols.join(", ")
            ));
        }
        let mut ddl = format!("CREATE TABLE {} (\n{}\n);", self.quote_table(table), lines.join(",\n"));
        for def in index_defs {
            ddl.push('\n');
            ddl.push_str(def);
            ddl.push(';');
        }
        ddl
    }
}

impl std::fmt::Debug for PostgresDriver {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PostgresDriver").field("database", &self.database).field("tls", &self.tls).finish()
    }
}
