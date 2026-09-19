//! SQLite integration tests: type fidelity on the wire, introspection, the
//! data-view SQL builders, change rendering and the read-only mode.

use plinth_core::*;
use plinth_drivers::SqlxFactory;
use serde_json::json;
use std::collections::BTreeMap;
use std::sync::Arc;

fn profile(path: &str) -> ConnectionProfile {
    ConnectionProfile {
        id: "test".into(),
        name: "test".into(),
        driver: DriverKind::Sqlite,
        environment: Environment::Local,
        policy: PolicyMode::ReadWrite,
        color: None,
        host: None,
        port: None,
        database: None,
        user: None,
        file_path: Some(path.to_string()),
        ssl: SslMode::Disable,
        has_password: false,
        last_used_at: None,
        favorite: false,
        folder: None,
        statement_timeout_ms: None,
    }
}

const SCHEMA: &str = r#"
CREATE TABLE fixtures (
  id INTEGER PRIMARY KEY,
  big INTEGER,
  num NUMERIC,
  dec DECIMAL(20,4),
  -- NUMERIC affinity keeps only 15 significant digits; exact decimals need TEXT affinity.
  amount TEXT,
  f REAL,
  s TEXT,
  b BLOB,
  j JSON,
  dt DATETIME,
  flag BOOLEAN,
  untyped
);
CREATE TABLE parent (pid INTEGER PRIMARY KEY, label TEXT NOT NULL DEFAULT 'x');
CREATE TABLE child (
  cid INTEGER PRIMARY KEY,
  pid INTEGER NOT NULL REFERENCES parent(pid),
  code TEXT,
  UNIQUE (code)
);
CREATE INDEX child_pid_idx ON child (pid);
CREATE VIEW parent_view AS SELECT pid, label FROM parent;
CREATE TABLE nopk (a INTEGER, b TEXT);
"#;

const ROWS: &str = r#"
INSERT INTO fixtures VALUES
  (1, -9223372036854775808, 0.1, 12.5, '10000000000000.0001', 0.1, '', X'00ff10', '{"a":[1,2,{"b":null}]}', '2024-03-09 01:02:03', 1, 42),
  (2, 9223372036854775807, 9007199254740993, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, 'text'),
  (3, 9007199254740993, NULL, 42, '-0.0001', 1e300, '😀 grin', X'', '[1, "two"]', '2024-03-09T01:02:03.123', 1, NULL);
INSERT INTO parent VALUES (1, 'one'), (2, 'two'), (3, 'three');
INSERT INTO child VALUES (10, 1, 'a'), (11, 1, 'b'), (12, 2, 'c');
"#;

struct Db {
    _dir: tempfile::TempDir,
    path: String,
}

async fn fresh_db() -> Db {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("fixture.db").to_string_lossy().into_owned();
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(sqlx::sqlite::SqliteConnectOptions::new().filename(&path).create_if_missing(true))
        .await
        .expect("create db");
    sqlx::raw_sql(SCHEMA).execute(&pool).await.expect("schema");
    sqlx::raw_sql(ROWS).execute(&pool).await.expect("rows");
    pool.close().await;
    Db { _dir: dir, path }
}

async fn open(db: &Db, read_only: bool) -> Arc<dyn Driver> {
    SqlxFactory.connect(&profile(&db.path), None, None, read_only).await.expect("connect")
}

fn col<'a>(m: &'a Materialized, name: &str) -> (usize, &'a ColumnDesc) {
    m.columns.iter().enumerate().find(|(_, c)| c.name == name).unwrap_or_else(|| panic!("column {name}"))
}

#[tokio::test]
async fn boundary_values_follow_wire_rules() {
    let db = fresh_db().await;
    let d = open(&db, false).await;
    let m = d.execute("SELECT * FROM fixtures ORDER BY id", &QueryOpts::default()).await.expect("execute");
    assert_eq!(m.rows.len(), 3);
    assert!(!m.truncated);
    assert_eq!(m.rows_affected, None);

    // Column descriptors come from the declared types.
    let (big, big_desc) = col(&m, "big");
    assert_eq!((big_desc.logical, big_desc.wire), (LogicalType::Int, WireKind::String));
    assert_eq!(big_desc.data_type, "INTEGER");
    let (num, num_desc) = col(&m, "num");
    assert_eq!((num_desc.logical, num_desc.wire), (LogicalType::Decimal, WireKind::String));
    let (dec, dec_desc) = col(&m, "dec");
    assert_eq!(dec_desc.data_type, "DECIMAL(20,4)");
    assert_eq!((dec_desc.logical, dec_desc.wire), (LogicalType::Decimal, WireKind::String));
    let (amount, amount_desc) = col(&m, "amount");
    assert_eq!((amount_desc.logical, amount_desc.wire), (LogicalType::Text, WireKind::String));
    let (f, f_desc) = col(&m, "f");
    assert_eq!((f_desc.logical, f_desc.wire), (LogicalType::Float, WireKind::Number));
    let (s, s_desc) = col(&m, "s");
    assert_eq!(s_desc.wire, WireKind::String);
    let (b, b_desc) = col(&m, "b");
    assert_eq!(b_desc.logical, LogicalType::Bytes);
    let (j, j_desc) = col(&m, "j");
    assert_eq!((j_desc.logical, j_desc.wire), (LogicalType::Json, WireKind::Json));
    let (dt, dt_desc) = col(&m, "dt");
    assert_eq!(dt_desc.logical, LogicalType::Timestamp);
    let (flag, flag_desc) = col(&m, "flag");
    assert_eq!((flag_desc.logical, flag_desc.wire), (LogicalType::Bool, WireKind::Bool));
    let (untyped, untyped_desc) = col(&m, "untyped");
    // No declared type: inferred from the first non-null storage class (INTEGER 42).
    assert_eq!(untyped_desc.logical, LogicalType::Int);
    assert_eq!(big_desc.table.as_ref().map(|t| t.name.as_str()), Some("fixtures"));
    assert_eq!(col(&m, "id").1.nullable, Some(false));
    assert_eq!(big_desc.nullable, Some(true));

    let r1 = &m.rows[0];
    let r2 = &m.rows[1];
    let r3 = &m.rows[2];

    // Integers are strings, never JSON numbers.
    assert_eq!(r1[big], json!("-9223372036854775808"));
    assert_eq!(r2[big], json!("9223372036854775807"));
    assert_eq!(r3[big], json!("9007199254740993"));
    assert_eq!(r1[0], json!("1"));

    // Decimals are strings, never JSON numbers; TEXT-affinity decimals are exact.
    assert_eq!(r1[num], json!("0.1"));
    assert_eq!(r2[num], json!("9007199254740993"));
    assert_eq!(r3[num], Cell::Null);
    assert_eq!(r1[dec], json!("12.5"));
    assert_eq!(r3[dec], json!("42"));
    assert_eq!(r2[dec], Cell::Null);
    assert_eq!(r1[amount], json!("10000000000000.0001"));
    assert_eq!(r2[amount], Cell::Null);
    assert_eq!(r3[amount], json!("-0.0001"));

    // Floats are JSON numbers.
    assert_eq!(r1[f], json!(0.1));
    assert!(r1[f].is_number());
    assert_eq!(r3[f].to_string(), "1e+300");
    assert_eq!(r3[f].as_f64(), Some(1e300));
    assert_eq!(r2[f], Cell::Null);

    // Empty string vs NULL, 4-byte UTF-8.
    assert_eq!(r1[s], json!(""));
    assert_eq!(r2[s], Cell::Null);
    assert_eq!(r3[s], json!("😀 grin"));

    // Bytes are base64.
    assert_eq!(r1[b], json!("AP8Q"));
    assert_eq!(r3[b], json!(""));
    assert_eq!(r2[b], Cell::Null);

    // JSON columns carry parsed JSON.
    assert_eq!(r1[j], json!({"a": [1, 2, {"b": null}]}));
    assert_eq!(r3[j], json!([1, "two"]));
    assert_eq!(r2[j], Cell::Null);

    // Datetime text is passed through unchanged.
    assert_eq!(r1[dt], json!("2024-03-09 01:02:03"));
    assert_eq!(r3[dt], json!("2024-03-09T01:02:03.123"));

    // Booleans.
    assert_eq!(r1[flag], json!(true));
    assert_eq!(r2[flag], json!(false));

    // Untyped column: integer storage → string; text stays text.
    assert_eq!(r1[untyped], json!("42"));
    assert_eq!(r2[untyped], json!("text"));
    assert_eq!(r3[untyped], Cell::Null);
}

#[tokio::test]
async fn expression_columns_infer_from_values() {
    let db = fresh_db().await;
    let d = open(&db, false).await;
    let m = d
        .execute("SELECT 1 + 1 AS two, 1.5 AS half, 'x' AS t, NULL AS n, typeof(big) AS ty FROM fixtures WHERE id = 1", &QueryOpts::default())
        .await
        .expect("execute");
    let (two, two_desc) = col(&m, "two");
    assert_eq!(two_desc.logical, LogicalType::Int);
    assert_eq!(m.rows[0][two], json!("2"));
    let (half, half_desc) = col(&m, "half");
    assert_eq!(half_desc.wire, WireKind::Number);
    assert_eq!(m.rows[0][half], json!(1.5));
    let (t, _) = col(&m, "t");
    assert_eq!(m.rows[0][t], json!("x"));
    let (n, n_desc) = col(&m, "n");
    assert_eq!(n_desc.logical, LogicalType::Unknown);
    assert_eq!(m.rows[0][n], Cell::Null);
    let (ty, _) = col(&m, "ty");
    assert_eq!(m.rows[0][ty], json!("integer"));
}

#[tokio::test]
async fn schema_index_lists_objects_and_columns() {
    let db = fresh_db().await;
    let d = open(&db, false).await;
    let idx = d.schema_index().await.expect("schema_index");
    assert_eq!(idx.schemas.len(), 1);
    let main = &idx.schemas[0];
    assert_eq!(main.name, "main");
    assert!(!main.is_system);
    let names: Vec<(&str, ObjectKind)> = main.objects.iter().map(|o| (o.name.as_str(), o.kind)).collect();
    assert!(names.contains(&("fixtures", ObjectKind::Table)));
    assert!(names.contains(&("parent_view", ObjectKind::View)));
    assert!(names.contains(&("nopk", ObjectKind::Table)));
    // No ANALYZE has run: no estimates, and never a COUNT(*).
    assert!(main.objects.iter().all(|o| o.row_estimate.is_none()));
    assert!(idx.columns.iter().any(|c| c.table == "child" && c.column == "pid"));
    assert!(idx.columns.iter().any(|c| c.table == "parent_view" && c.column == "label"));
    assert!(!idx.generated_at.is_empty());

    // After ANALYZE the planner stats provide estimates.
    sqlx::raw_sql("ANALYZE").execute(&sqlx::SqlitePool::connect(&db.path).await.expect("pool")).await.expect("analyze");
    let idx = d.schema_index().await.expect("schema_index");
    let parent = idx.schemas[0].objects.iter().find(|o| o.name == "parent").expect("parent");
    assert_eq!(parent.row_estimate, Some(3));
}

#[tokio::test]
async fn describe_table_reports_keys_and_indexes() {
    let db = fresh_db().await;
    let d = open(&db, false).await;
    let t = d.describe_table(&TableRef { schema: None, name: "child".into() }).await.expect("describe");
    assert_eq!(t.kind, ObjectKind::Table);
    assert_eq!(t.primary_key, vec!["cid".to_string()]);
    let cols: Vec<(&str, &str, bool, u32)> = t.columns.iter().map(|c| (c.name.as_str(), c.data_type.as_str(), c.nullable, c.ordinal)).collect();
    assert_eq!(cols, vec![("cid", "INTEGER", false, 0), ("pid", "INTEGER", false, 1), ("code", "TEXT", true, 2)]);
    assert!(t.columns[0].is_primary_key);
    assert_eq!(t.columns[2].logical, LogicalType::Text);

    assert_eq!(t.foreign_keys.len(), 1);
    let fk = &t.foreign_keys[0];
    assert_eq!(fk.columns, vec!["pid".to_string()]);
    assert_eq!(fk.ref_table.name, "parent");
    assert_eq!(fk.ref_columns, vec!["pid".to_string()]);

    let pk_idx = t.indexes.iter().find(|i| i.primary).expect("pk index");
    assert_eq!(pk_idx.columns, vec!["cid".to_string()]);
    let named = t.indexes.iter().find(|i| i.name == "child_pid_idx").expect("child_pid_idx");
    assert_eq!(named.columns, vec!["pid".to_string()]);
    assert!(!named.unique);
    let uniq = t.indexes.iter().find(|i| i.unique && !i.primary).expect("unique index");
    assert_eq!(uniq.columns, vec!["code".to_string()]);

    assert!(t.ddl.as_deref().unwrap_or("").starts_with("CREATE TABLE child"));

    let parent = d.describe_table(&TableRef { schema: Some("main".into()), name: "parent".into() }).await.expect("describe");
    assert_eq!(parent.columns[1].default.as_deref(), Some("'x'"));
    let view = d.describe_table(&TableRef { schema: None, name: "parent_view".into() }).await.expect("view");
    assert_eq!(view.kind, ObjectKind::View);
    assert!(view.primary_key.is_empty());
    let missing = d.describe_table(&TableRef { schema: None, name: "nope".into() }).await;
    assert_eq!(missing.err().map(|e| e.code), Some("not-found".to_string()));
}

#[tokio::test]
async fn count_exact_and_estimate() {
    let db = fresh_db().await;
    let d = open(&db, false).await;
    let t = TableRef { schema: None, name: "child".into() };
    assert_eq!(d.count(&t, true).await.expect("exact"), 3);
    // Without stats the estimate falls back to the exact count.
    assert_eq!(d.count(&t, false).await.expect("estimate"), 3);
}

#[tokio::test]
async fn build_table_select_snapshots() {
    let db = fresh_db().await;
    let d = open(&db, false).await;
    let table = TableRef { schema: None, name: "fixtures".into() };
    let schema = d.describe_table(&table).await.expect("describe");

    let plain = d.build_table_select(&table, &schema, &TableQuery::default());
    assert_eq!(
        plain,
        "SELECT \"id\", \"big\", \"num\", \"dec\", \"amount\", \"f\", \"s\", \"b\", \"j\", \"dt\", \"flag\", \"untyped\" FROM \"fixtures\" LIMIT 1000"
    );

    let q = TableQuery {
        filters: vec![
            Filter { column: "big".into(), op: FilterOp::Gt, value: Some("5".into()) },
            Filter { column: "s".into(), op: FilterOp::Like, value: Some("%o'k%".into()) },
            Filter { column: "id".into(), op: FilterOp::In, value: Some("1, 2,3".into()) },
            Filter { column: "num".into(), op: FilterOp::Eq, value: Some("abc".into()) },
            Filter { column: "flag".into(), op: FilterOp::Eq, value: Some("true".into()) },
            Filter { column: "dt".into(), op: FilterOp::IsNotNull, value: None },
            Filter { column: "j".into(), op: FilterOp::IsNull, value: None },
        ],
        sort: vec![Sort { column: "big".into(), dir: SortDir::Desc }, Sort { column: "id".into(), dir: SortDir::Asc }],
        limit: Some(50),
        offset: Some(100),
    };
    let sql = d.build_table_select(&table, &schema, &q);
    assert_eq!(
        sql,
        "SELECT \"id\", \"big\", \"num\", \"dec\", \"amount\", \"f\", \"s\", \"b\", \"j\", \"dt\", \"flag\", \"untyped\" FROM \"fixtures\" \
         WHERE \"big\" > 5 AND \"s\" LIKE '%o''k%' AND \"id\" IN (1, 2, 3) AND \"num\" = 'abc' AND \"flag\" = 1 \
         AND \"dt\" IS NOT NULL AND \"j\" IS NULL ORDER BY \"big\" DESC, \"id\" ASC LIMIT 50 OFFSET 100"
    );
    // The generated SQL actually runs.
    let m = d.execute(&sql, &QueryOpts::default()).await.expect("run");
    assert!(m.rows.is_empty());

    let m = d
        .execute(
            &d.build_table_select(
                &table,
                &schema,
                &TableQuery {
                    filters: vec![Filter { column: "s".into(), op: FilterOp::Eq, value: Some("".into()) }],
                    sort: vec![],
                    limit: Some(10),
                    offset: None,
                },
            ),
            &QueryOpts::default(),
        )
        .await
        .expect("run");
    assert_eq!(m.rows.len(), 1);
    assert_eq!(m.rows[0][0], json!("1"));
}

fn pk(id: &str) -> BTreeMap<String, Cell> {
    BTreeMap::from([("id".to_string(), json!(id))])
}

#[tokio::test]
async fn render_changes_snapshots_and_pk_rule() {
    let db = fresh_db().await;
    let d = open(&db, false).await;
    let table = TableRef { schema: None, name: "fixtures".into() };
    let schema = d.describe_table(&table).await.expect("describe");

    let changes = ChangeSet {
        table: Some(table.clone()),
        updates: vec![
            CellChange { pk: pk("1"), column: "s".into(), value: json!("it's") },
            CellChange { pk: pk("2"), column: "num".into(), value: json!("10000000000000.0001") },
            CellChange { pk: pk("2"), column: "f".into(), value: json!(2.5) },
            CellChange { pk: pk("3"), column: "flag".into(), value: json!(false) },
            CellChange { pk: pk("3"), column: "j".into(), value: json!({"k": [1, "v"]}) },
            CellChange { pk: pk("3"), column: "b".into(), value: json!("AP8Q") },
            CellChange { pk: pk("3"), column: "dt".into(), value: Cell::Null },
        ],
        inserts: vec![RowInsert { values: BTreeMap::from([("id".to_string(), json!("9")), ("big".to_string(), json!("9007199254740993"))]) }],
        deletes: vec![RowDelete { pk: pk("1") }],
    };
    let stmts = d.render_changes(&schema, &changes).expect("render");
    assert_eq!(
        stmts,
        vec![
            "UPDATE \"fixtures\" SET \"s\" = 'it''s' WHERE \"id\" = '1'",
            "UPDATE \"fixtures\" SET \"num\" = '10000000000000.0001' WHERE \"id\" = '2'",
            "UPDATE \"fixtures\" SET \"f\" = 2.5 WHERE \"id\" = '2'",
            "UPDATE \"fixtures\" SET \"flag\" = 0 WHERE \"id\" = '3'",
            "UPDATE \"fixtures\" SET \"j\" = '{\"k\":[1,\"v\"]}' WHERE \"id\" = '3'",
            "UPDATE \"fixtures\" SET \"b\" = X'00ff10' WHERE \"id\" = '3'",
            "UPDATE \"fixtures\" SET \"dt\" = NULL WHERE \"id\" = '3'",
            "INSERT INTO \"fixtures\" (\"big\", \"id\") VALUES ('9007199254740993', '9')",
            "DELETE FROM \"fixtures\" WHERE \"id\" = '1'",
        ]
    );

    // Tables without a primary key cannot be updated or deleted.
    let nopk_ref = TableRef { schema: None, name: "nopk".into() };
    let nopk = d.describe_table(&nopk_ref).await.expect("describe");
    let err = d
        .render_changes(
            &nopk,
            &ChangeSet {
                table: None,
                updates: vec![CellChange { pk: BTreeMap::new(), column: "b".into(), value: json!("x") }],
                inserts: vec![],
                deletes: vec![],
            },
        )
        .expect_err("no pk");
    assert_eq!(err.code, "invalid");
    // Unknown columns are rejected.
    let err = d
        .render_changes(
            &schema,
            &ChangeSet { table: None, updates: vec![CellChange { pk: pk("1"), column: "zzz".into(), value: json!("x") }], inserts: vec![], deletes: vec![] },
        )
        .expect_err("unknown column");
    assert_eq!(err.code, "invalid");
}

#[tokio::test]
async fn apply_round_trip() {
    let db = fresh_db().await;
    let d = open(&db, false).await;
    let table = TableRef { schema: None, name: "fixtures".into() };
    let schema = d.describe_table(&table).await.expect("describe");
    let changes = ChangeSet {
        table: None,
        updates: vec![
            CellChange { pk: pk("2"), column: "s".into(), value: json!("changed 😀") },
            CellChange { pk: pk("2"), column: "amount".into(), value: json!("10000000000000.0001") },
            CellChange { pk: pk("2"), column: "big".into(), value: json!("-9007199254740993") },
        ],
        inserts: vec![RowInsert { values: BTreeMap::from([("id".to_string(), json!("4")), ("s".to_string(), json!("new"))]) }],
        deletes: vec![RowDelete { pk: pk("3") }],
    };
    let stmts = d.render_changes(&schema, &changes).expect("render");
    let affected = d.apply(&stmts).await.expect("apply");
    assert_eq!(affected, 5);

    let m = d.execute("SELECT id, big, amount, s FROM fixtures ORDER BY id", &QueryOpts::default()).await.expect("select");
    assert_eq!(m.rows.len(), 3);
    assert_eq!(m.rows[1], vec![json!("2"), json!("-9007199254740993"), json!("10000000000000.0001"), json!("changed 😀")]);
    assert_eq!(m.rows[2], vec![json!("4"), Cell::Null, Cell::Null, json!("new")]);

    // A failing statement rolls the whole batch back.
    let err = d
        .apply(&["UPDATE \"fixtures\" SET \"s\" = 'lost' WHERE \"id\" = '1'".to_string(), "INSERT INTO nope VALUES (1)".to_string()])
        .await
        .expect_err("rollback");
    assert_eq!(err.code, "driver");
    let m = d.execute("SELECT s FROM fixtures WHERE id = 1", &QueryOpts::default()).await.expect("select");
    assert_eq!(m.rows[0][0], json!(""));
}

#[tokio::test]
async fn non_row_statements_report_rows_affected() {
    let db = fresh_db().await;
    let d = open(&db, false).await;
    let m = d.execute("UPDATE parent SET label = 'z' WHERE pid > 1", &QueryOpts::default()).await.expect("update");
    assert!(m.columns.is_empty());
    assert!(m.rows.is_empty());
    assert_eq!(m.rows_affected, Some(2));
    let m = d.execute("CREATE TABLE extra (x INTEGER)", &QueryOpts::default()).await.expect("ddl");
    assert_eq!(m.rows_affected, Some(0));
    let m = d.execute("SELECT * FROM parent WHERE pid > 100", &QueryOpts::default()).await.expect("empty select");
    assert_eq!(m.columns.len(), 2);
    assert_eq!(m.rows_affected, None);
    assert!(m.rows.is_empty());
}

#[tokio::test]
async fn read_only_pool_rejects_writes() {
    let db = fresh_db().await;
    let d = open(&db, true).await;
    let err = d.execute("INSERT INTO parent VALUES (99, 'nope')", &QueryOpts::default()).await.expect_err("insert must fail");
    assert_eq!(err.code, "driver");
    assert!(err.message.to_ascii_lowercase().contains("readonly"), "{}", err.message);
    // Reads still work.
    let m = d.execute("SELECT COUNT(*) AS n FROM parent", &QueryOpts::default()).await.expect("select");
    assert_eq!(m.rows[0][0], json!("3"));
    let err = d.apply(&["DELETE FROM parent".to_string()]).await.expect_err("apply must fail");
    assert_eq!(err.code, "driver");
}

#[tokio::test]
async fn read_only_query_opts_on_writable_pool() {
    let db = fresh_db().await;
    let d = open(&db, false).await;
    let opts = QueryOpts { read_only: true, ..QueryOpts::default() };
    let err = d.execute("DELETE FROM parent", &opts).await.expect_err("must be blocked");
    assert_eq!(err.code, "driver");
    // The guard is per statement: a normal execute afterwards can write.
    let m = d.execute("UPDATE parent SET label = 'ok' WHERE pid = 1", &QueryOpts::default()).await.expect("write");
    assert_eq!(m.rows_affected, Some(1));
    let m = d.execute("SELECT COUNT(*) FROM parent", &opts).await.expect("read");
    assert_eq!(m.rows[0][0], json!("3"));
}

#[tokio::test]
async fn execute_truncates_at_limit() {
    let db = fresh_db().await;
    let d = open(&db, false).await;
    let opts = QueryOpts { limit: Some(2), ..QueryOpts::default() };
    let m = d.execute("SELECT pid FROM parent ORDER BY pid", &opts).await.expect("select");
    assert_eq!(m.rows.len(), 2);
    assert!(m.truncated);
    let opts = QueryOpts { limit: Some(3), ..QueryOpts::default() };
    let m = d.execute("SELECT pid FROM parent ORDER BY pid", &opts).await.expect("select");
    assert_eq!(m.rows.len(), 3);
    assert!(!m.truncated);
    let opts = QueryOpts { limit: Some(0), ..QueryOpts::default() };
    let m = d.execute("SELECT pid FROM parent ORDER BY pid", &opts).await.expect("select");
    assert!(m.rows.is_empty());
    assert!(m.truncated);
}

#[tokio::test]
async fn execute_times_out() {
    let db = fresh_db().await;
    let d = open(&db, false).await;
    let opts = QueryOpts { timeout_ms: Some(50), ..QueryOpts::default() };
    // A recursive CTE that never finishes.
    let err = d
        .execute("WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r) SELECT COUNT(*) FROM r", &opts)
        .await
        .expect_err("must time out");
    assert!(err.message.contains("timed out"), "{}", err.message);
    // The pool is still usable afterwards.
    d.ping().await.expect("ping");
    let m = d.execute("SELECT 1", &QueryOpts::default()).await.expect("select");
    assert_eq!(m.rows[0][0], json!("1"));
}

#[tokio::test]
async fn misc_driver_surface() {
    let db = fresh_db().await;
    let d = open(&db, false).await;
    assert_eq!(d.kind(), DriverKind::Sqlite);
    assert!(d.server_version().await.expect("version").starts_with("SQLite 3."));
    assert!(!d.tls());
    assert_eq!(d.list_databases().await.expect("dbs"), vec!["fixture".to_string()]);
    assert_eq!(d.current_database(), "fixture");
    assert_eq!(d.quote_ident("we\"ird"), "\"we\"\"ird\"");
    assert_eq!(d.quote_table(&TableRef { schema: Some("main".into()), name: "t".into() }), "\"main\".\"t\"");
    d.cancel().await.expect("cancel is a no-op");
    let err = d.execute("SELECT * FROM missing_table", &QueryOpts::default()).await.expect_err("bad sql");
    assert_eq!(err.code, "driver");
    assert!(err.message.contains("missing_table"));
    d.close().await;
}
