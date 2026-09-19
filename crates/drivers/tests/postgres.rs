//! PostgreSQL integration tests. They need a live server:
//!
//! ```sh
//! PLINTH_TEST_PG_URL=postgres://user:pass@localhost/db cargo test -p plinth-drivers --test postgres -- --ignored
//! ```

use plinth_core::*;
use plinth_drivers::PostgresDriver;
use serde_json::json;
use sqlx::postgres::PgConnectOptions;
use std::collections::BTreeMap;
use std::str::FromStr;
use std::time::Duration;

fn url() -> Option<String> {
    std::env::var("PLINTH_TEST_PG_URL").ok().filter(|u| !u.is_empty())
}

async fn connect(read_only: bool) -> Option<PostgresDriver> {
    let url = url()?;
    let opts = PgConnectOptions::from_str(&url).expect("valid PLINTH_TEST_PG_URL");
    Some(PostgresDriver::connect(opts, read_only, SessionLimits::default()).await.expect("connect"))
}

/// Each test gets its own schema so they can run in parallel.
async fn scratch_schema(d: &PostgresDriver, name: &str) -> String {
    let schema = format!("plinth_t_{name}");
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!("DROP SCHEMA IF EXISTS {schema} CASCADE; CREATE SCHEMA {schema}")))
        .execute(d.pool())
        .await
        .expect("scratch schema");
    schema
}

async fn drop_schema(d: &PostgresDriver, schema: &str) {
    let _ = sqlx::raw_sql(sqlx::AssertSqlSafe(format!("DROP SCHEMA IF EXISTS {schema} CASCADE"))).execute(d.pool()).await;
}

fn col<'a>(m: &'a Materialized, name: &str) -> (usize, &'a ColumnDesc) {
    m.columns.iter().enumerate().find(|(_, c)| c.name == name).unwrap_or_else(|| panic!("column {name}"))
}

/// The server is the oracle: whatever `value::text` says, the driver must say.
///
/// A client that prints `1.5000` where the database prints `1.5` has changed
/// the number's scale, which for `numeric` is part of the value.
#[tokio::test]
#[ignore = "needs PLINTH_TEST_PG_URL; run with --ignored"]
async fn pg_numeric_scale_matches_the_server() {
    let Some(d) = connect(false).await else { return };
    let literals = [
        "1.5", "1.50", "0.1", "-0.0001", "10000000000000.0001", "2", "2.0",
        "1e10", "0.000000000000000001", "-12345678901234567890.12345",
    ];
    let selects: Vec<String> = literals
        .iter()
        .map(|l| format!("SELECT '{l}'::numeric AS v, ('{l}'::numeric)::text AS t, ARRAY['{l}'::numeric] AS a, (ARRAY['{l}'::numeric])::text AS at"))
        .collect();

    for (lit, sql) in literals.iter().zip(selects) {
        let m = d.execute(&sql, &QueryOpts::default()).await.expect("execute");
        let row = &m.rows[0];
        let (v, _) = col(&m, "v");
        let (t, _) = col(&m, "t");
        let (a, _) = col(&m, "a");
        let expected = row[t].as_str().expect("text").to_string();
        assert_eq!(row[v], json!(expected), "scalar numeric {lit}");
        assert_eq!(row[a], json!([expected]), "numeric[] element {lit}");
    }
}

#[tokio::test]
#[ignore = "needs PLINTH_TEST_PG_URL; run with --ignored"]
async fn pg_boundary_values_follow_wire_rules() {
    let Some(d) = connect(false).await else { return };
    let s = scratch_schema(&d, "types").await;
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
        "CREATE TABLE {s}.t (
            id bigserial PRIMARY KEY, i2 smallint, i4 integer, i8 bigint, n numeric(30,4), n2 numeric, f8 float8, f4 real,
            t text, vc varchar(10), b bytea, j jsonb, js json, ts timestamp, tstz timestamptz, d date, tm time, u uuid,
            ta text[], ia bigint[], na numeric[], bo boolean, iv interval, ip inet, m money, bits bit(4)
        );
        INSERT INTO {s}.t (i2, i4, i8, n, n2, f8, f4, t, vc, b, j, js, ts, tstz, d, tm, u, ta, ia, na, bo, iv, ip, m, bits) VALUES
          (-32768, 2147483647, -9223372036854775808, '10000000000000.0001', 'NaN', 0.1, 0.1, '', 'x', '\\x00ff10', '{{\"a\":[1,2,{{\"b\":null}}]}}', '[1]',
           '2024-03-09 01:02:03.000001', '2024-03-09 01:02:03+02', '9999-12-31', '23:59:59.5', '123e4567-e89b-12d3-a456-426614174000',
           ARRAY['a', NULL, 'c'], ARRAY[1, 9007199254740993::bigint], ARRAY[1.5::numeric], true, '1 year 2 mons 3 days 04:05:06', '10.0.0.1/24', 12.34, B'1010'),
          (32767, -2147483648, 9223372036854775807, -0.0001, '1e10', 'Infinity', 'NaN', '😀 \\0-free', NULL, '\\x', NULL, NULL,
           'infinity', NULL, NULL, NULL, NULL, '{{}}', NULL, NULL, false, NULL, NULL, NULL, NULL);"
    )))
    .execute(d.pool())
    .await
    .expect("fixture");

    let m = d.execute(&format!("SELECT * FROM {s}.t ORDER BY id"), &QueryOpts::default()).await.expect("execute");
    assert_eq!(m.rows.len(), 2);
    let r1 = &m.rows[0];
    let r2 = &m.rows[1];

    let (id, id_desc) = col(&m, "id");
    assert_eq!((id_desc.logical, id_desc.wire, id_desc.data_type.as_str()), (LogicalType::Int, WireKind::String, "int8"));
    assert_eq!(r1[id], json!("1"));
    assert_eq!(r1[col(&m, "i2").0], json!("-32768"));
    assert_eq!(r2[col(&m, "i4").0], json!("-2147483648"));
    assert_eq!(r1[col(&m, "i8").0], json!("-9223372036854775808"));
    assert_eq!(r2[col(&m, "i8").0], json!("9223372036854775807"));

    let (n, n_desc) = col(&m, "n");
    assert_eq!((n_desc.logical, n_desc.wire), (LogicalType::Decimal, WireKind::String));
    assert_eq!(r1[n], json!("10000000000000.0001"));
    assert_eq!(r2[n], json!("-0.0001"));
    assert_eq!(r1[col(&m, "n2").0], json!("NaN"));
    assert_eq!(r2[col(&m, "n2").0], json!("10000000000"));

    let (f8, f8_desc) = col(&m, "f8");
    assert_eq!(f8_desc.wire, WireKind::Number);
    assert_eq!(r1[f8], json!(0.1));
    assert_eq!(r2[f8], json!("Infinity"));
    assert_eq!(r1[col(&m, "f4").0].to_string(), "0.1");
    assert_eq!(r2[col(&m, "f4").0], json!("NaN"));

    assert_eq!(r1[col(&m, "t").0], json!(""));
    assert_eq!(r2[col(&m, "t").0], json!("😀 \\0-free"));
    assert_eq!(r2[col(&m, "vc").0], Cell::Null);
    assert_eq!(r1[col(&m, "b").0], json!("AP8Q"));
    assert_eq!(r2[col(&m, "b").0], json!(""));
    let (j, j_desc) = col(&m, "j");
    assert_eq!(j_desc.wire, WireKind::Json);
    assert_eq!(r1[j], json!({"a": [1, 2, {"b": null}]}));
    assert_eq!(r1[col(&m, "js").0], json!([1]));
    assert_eq!(r1[col(&m, "ts").0], json!("2024-03-09T01:02:03.000001"));
    assert_eq!(r2[col(&m, "ts").0], json!("infinity"));
    assert_eq!(r1[col(&m, "tstz").0], json!("2024-03-08T23:02:03+00:00"));
    assert_eq!(r1[col(&m, "d").0], json!("9999-12-31"));
    assert_eq!(r1[col(&m, "tm").0], json!("23:59:59.500"));
    assert_eq!(r1[col(&m, "u").0], json!("123e4567-e89b-12d3-a456-426614174000"));
    let (ta, ta_desc) = col(&m, "ta");
    assert_eq!((ta_desc.logical, ta_desc.wire), (LogicalType::Array, WireKind::Json));
    assert_eq!(r1[ta], json!(["a", null, "c"]));
    assert_eq!(r2[ta], json!([]));
    assert_eq!(r1[col(&m, "ia").0], json!(["1", "9007199254740993"]));
    assert_eq!(r1[col(&m, "na").0], json!(["1.5"]));
    assert_eq!(r1[col(&m, "bo").0], json!(true));
    assert_eq!(r2[col(&m, "bo").0], json!(false));
    assert_eq!(r1[col(&m, "iv").0], json!("1 year 2 mons 3 days 04:05:06"));
    assert_eq!(r1[col(&m, "ip").0], json!("10.0.0.1/24"));
    assert_eq!(r1[col(&m, "m").0], json!("12.34"));
    assert_eq!(r1[col(&m, "bits").0], json!("1010"));

    drop_schema(&d, &s).await;
}

#[tokio::test]
#[ignore = "needs PLINTH_TEST_PG_URL; run with --ignored"]
async fn pg_introspection() {
    let Some(d) = connect(false).await else { return };
    let s = scratch_schema(&d, "intro").await;
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
        "CREATE TABLE {s}.parent (pid bigint PRIMARY KEY, label text NOT NULL DEFAULT 'x');
         CREATE TABLE {s}.child (
            cid serial, pid bigint NOT NULL REFERENCES {s}.parent(pid), code varchar(8) UNIQUE, amount numeric(19,4),
            PRIMARY KEY (cid)
         );
         CREATE INDEX child_pid_idx ON {s}.child (pid, lower(code));
         CREATE VIEW {s}.parent_view AS SELECT pid, label FROM {s}.parent;
         CREATE FUNCTION {s}.f1() RETURNS int LANGUAGE sql AS 'SELECT 1';
         INSERT INTO {s}.parent VALUES (1, 'one'), (2, 'two'), (3, 'three');
         ANALYZE {s}.parent;"
    )))
    .execute(d.pool())
    .await
    .expect("fixture");

    let idx = d.schema_index().await.expect("schema_index");
    assert!(idx.schemas.iter().any(|x| x.name == "pg_catalog" && x.is_system));
    assert!(idx.schemas.iter().any(|x| x.name == "information_schema" && x.is_system));
    let scratch = idx.schemas.iter().find(|x| x.name == s).expect("scratch schema listed");
    assert!(!scratch.is_system);
    let find = |n: &str| scratch.objects.iter().find(|o| o.name == n).unwrap_or_else(|| panic!("{n}"));
    assert_eq!(find("parent").kind, ObjectKind::Table);
    assert_eq!(find("parent").row_estimate, Some(3));
    assert_eq!(find("parent_view").kind, ObjectKind::View);
    assert_eq!(find("f1").kind, ObjectKind::Function);
    assert_eq!(find("child_cid_seq").kind, ObjectKind::Sequence);
    assert!(idx.columns.iter().any(|c| c.schema == s && c.table == "child" && c.column == "amount"));

    let t = d.describe_table(&TableRef { schema: Some(s.clone()), name: "child".into() }).await.expect("describe");
    assert_eq!(t.kind, ObjectKind::Table);
    assert_eq!(t.primary_key, vec!["cid".to_string()]);
    let types: Vec<(&str, &str)> = t.columns.iter().map(|c| (c.name.as_str(), c.data_type.as_str())).collect();
    assert_eq!(types, vec![("cid", "integer"), ("pid", "bigint"), ("code", "character varying(8)"), ("amount", "numeric(19,4)")]);
    assert_eq!(t.columns[0].default.as_deref(), Some(&*format!("nextval('{s}.child_cid_seq'::regclass)")));
    assert!(!t.columns[1].nullable);
    assert!(t.columns[2].nullable);
    assert_eq!(t.columns[3].logical, LogicalType::Decimal);
    assert_eq!(t.foreign_keys.len(), 1);
    assert_eq!(t.foreign_keys[0].columns, vec!["pid".to_string()]);
    assert_eq!(t.foreign_keys[0].ref_table, TableRef { schema: Some(s.clone()), name: "parent".into() });
    assert_eq!(t.foreign_keys[0].ref_columns, vec!["pid".to_string()]);
    let pk_idx = t.indexes.iter().find(|i| i.primary).expect("pk index");
    assert_eq!(pk_idx.columns, vec!["cid".to_string()]);
    let named = t.indexes.iter().find(|i| i.name == "child_pid_idx").expect("child_pid_idx");
    // Postgres 17 prints `lower(code::text)`; 16 and earlier printed
    // `lower((code)::text)`. The driver passes the server's own rendering
    // through, so both are correct and the test accepts either.
    assert_eq!(named.columns.len(), 2);
    assert_eq!(named.columns[0], "pid");
    let expr = named.columns[1].replace('(', "").replace(')', "");
    assert_eq!(expr, "lower code::text".replace(' ', ""), "unexpected expression index rendering: {}", named.columns[1]);
    assert!(t.indexes.iter().any(|i| i.unique && !i.primary && i.columns == vec!["code".to_string()]));
    let ddl = t.ddl.expect("ddl");
    assert!(ddl.starts_with(&format!("CREATE TABLE \"{s}\".\"child\"")), "{ddl}");
    assert!(ddl.contains("\"amount\" numeric(19,4)"));
    assert!(ddl.contains("PRIMARY KEY (\"cid\")"));
    assert!(ddl.contains("FOREIGN KEY (\"pid\") REFERENCES"));
    assert!(ddl.contains("CREATE INDEX child_pid_idx"));

    let v = d.describe_table(&TableRef { schema: Some(s.clone()), name: "parent_view".into() }).await.expect("view");
    assert_eq!(v.kind, ObjectKind::View);
    assert!(v.ddl.unwrap_or_default().starts_with("CREATE VIEW"));

    let parent = TableRef { schema: Some(s.clone()), name: "parent".into() };
    assert_eq!(d.count(&parent, true).await.expect("exact"), 3);
    assert_eq!(d.count(&parent, false).await.expect("estimate"), 3);
    let missing = d.describe_table(&TableRef { schema: Some(s.clone()), name: "nope".into() }).await;
    assert_eq!(missing.err().map(|e| e.code), Some("not-found".to_string()));

    assert!(d.list_databases().await.expect("dbs").contains(&d.current_database()));
    assert!(d.server_version().await.expect("version").starts_with("PostgreSQL "));
    d.ping().await.expect("ping");
    drop_schema(&d, &s).await;
}

#[tokio::test]
#[ignore = "needs PLINTH_TEST_PG_URL; run with --ignored"]
async fn pg_execute_apply_and_read_only() {
    let Some(d) = connect(false).await else { return };
    let s = scratch_schema(&d, "exec").await;
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
        "CREATE TABLE {s}.orders (id bigint PRIMARY KEY, amount numeric(19,4), meta jsonb, note text);
         INSERT INTO {s}.orders VALUES (1, 1.5, '{{}}', 'a'), (2, 2.5, NULL, 'b'), (3, 3.5, NULL, 'c');"
    )))
    .execute(d.pool())
    .await
    .expect("fixture");
    let table = TableRef { schema: Some(s.clone()), name: "orders".into() };
    let schema = d.describe_table(&table).await.expect("describe");

    // Truncation and rows_affected.
    let m = d.execute(&format!("SELECT id FROM {s}.orders ORDER BY id"), &QueryOpts { limit: Some(2), ..QueryOpts::default() }).await.expect("select");
    assert_eq!(m.rows.len(), 2);
    assert!(m.truncated);
    let m = d.execute(&format!("UPDATE {s}.orders SET note = 'z' WHERE id > 1"), &QueryOpts::default()).await.expect("update");
    assert_eq!(m.rows_affected, Some(2));
    assert!(m.columns.is_empty());

    // Data-view SELECT round trip.
    let q = TableQuery {
        filters: vec![Filter { column: "amount".into(), op: FilterOp::Gt, value: Some("2".into()) }],
        sort: vec![Sort { column: "id".into(), dir: SortDir::Desc }],
        limit: Some(10),
        offset: None,
    };
    let m = d.execute(&d.build_table_select(&table, &schema, &q), &QueryOpts::default()).await.expect("view select");
    assert_eq!(m.rows.iter().map(|r| r[0].clone()).collect::<Vec<_>>(), vec![json!("3"), json!("2")]);

    // Apply with casts and read back.
    let changes = ChangeSet {
        table: None,
        updates: vec![
            CellChange { pk: BTreeMap::from([("id".to_string(), json!("1"))]), column: "amount".into(), value: json!("10000000000000.0001") },
            CellChange { pk: BTreeMap::from([("id".to_string(), json!("1"))]), column: "meta".into(), value: json!({"k": [1, "v"]}) },
        ],
        inserts: vec![RowInsert { values: BTreeMap::from([("id".to_string(), json!("4")), ("note".to_string(), json!("it's"))]) }],
        deletes: vec![RowDelete { pk: BTreeMap::from([("id".to_string(), json!("3"))]) }],
    };
    let stmts = d.render_changes(&schema, &changes).expect("render");
    assert_eq!(d.apply(&stmts).await.expect("apply"), 4);
    let m = d.execute(&format!("SELECT id, amount, meta, note FROM {s}.orders ORDER BY id"), &QueryOpts::default()).await.expect("select");
    assert_eq!(m.rows[0], vec![json!("1"), json!("10000000000000.0001"), json!({"k": [1, "v"]}), json!("a")]);
    assert_eq!(m.rows.last().map(|r| r[3].clone()), Some(json!("it's")));
    assert_eq!(m.rows.len(), 3);

    // A failing batch rolls back entirely.
    let err = d.apply(&[format!("DELETE FROM {s}.orders WHERE id = 1"), "SELECT 1/0".to_string()]).await.expect_err("rollback");
    assert_eq!(err.code, "driver");
    assert_eq!(err.detail.as_deref(), Some("22012"));
    assert_eq!(d.count(&table, true).await.expect("count"), 3);

    // Per-statement read-only transaction.
    let ro = QueryOpts { read_only: true, ..QueryOpts::default() };
    let err = d.execute(&format!("INSERT INTO {s}.orders (id) VALUES (99)"), &ro).await.expect_err("read only");
    assert_eq!(err.detail.as_deref(), Some("25006"));
    let m = d.execute(&format!("SELECT COUNT(*) FROM {s}.orders"), &ro).await.expect("read");
    assert_eq!(m.rows[0][0], json!("3"));

    // Read-only pool (factory flag).
    let ro_driver = connect(true).await.expect("ro driver");
    let err = ro_driver.execute(&format!("DELETE FROM {s}.orders"), &QueryOpts::default()).await.expect_err("read only pool");
    assert_eq!(err.detail.as_deref(), Some("25006"));
    ro_driver.close().await;

    drop_schema(&d, &s).await;
}

#[tokio::test]
#[ignore = "needs PLINTH_TEST_PG_URL; run with --ignored"]
async fn pg_cancel_and_timeout() {
    let Some(d) = connect(false).await else { return };
    let d = std::sync::Arc::new(d);
    let runner = {
        let d = d.clone();
        tokio::spawn(async move { d.execute("SELECT pg_sleep(10)", &QueryOpts { timeout_ms: None, ..QueryOpts::default() }).await })
    };
    tokio::time::sleep(Duration::from_millis(300)).await;
    d.cancel().await.expect("cancel");
    let err = runner.await.expect("join").expect_err("cancelled");
    assert_eq!(err.detail.as_deref(), Some("57014"), "{}", err.message);

    let err = d.execute("SELECT pg_sleep(10)", &QueryOpts { timeout_ms: Some(200), ..QueryOpts::default() }).await.expect_err("timeout");
    assert!(err.message.contains("timed out"));
    d.ping().await.expect("pool still usable");
}

/// The rail from PLAN-5 §1.1: the server, not the app, stops a runaway query.
#[tokio::test]
#[ignore = "needs PLINTH_TEST_PG_URL; run with --ignored"]
async fn pg_statement_timeout_is_applied_to_every_connection() {
    let Some(url) = url() else { return };
    let opts = PgConnectOptions::from_str(&url).expect("valid PLINTH_TEST_PG_URL");
    let limits = SessionLimits { statement_timeout_ms: Some(300) };
    let d = PostgresDriver::connect(opts, false, limits).await.expect("connect");

    let (setting,): (String,) = sqlx::query_as("SHOW statement_timeout").fetch_one(d.pool()).await.expect("show");
    assert_eq!(setting, "300ms", "the session carries the timeout");

    // A statement past the limit is cancelled by the server, not by us.
    let err = sqlx::raw_sql("SELECT pg_sleep(3)").execute(d.pool()).await.expect_err("should be cancelled");
    let msg = err.to_string();
    assert!(
        msg.contains("canceling statement") || msg.contains("statement timeout"),
        "expected a server cancellation, got: {msg}"
    );

    // A quick statement is untouched.
    let (one,): (i32,) = sqlx::query_as("SELECT 1").fetch_one(d.pool()).await.expect("fast query still fine");
    assert_eq!(one, 1);
}

/// PLAN-6 §2: every declared edge in the database, in one round trip, with
/// composite keys kept in column order — that ordering is what makes the
/// generated `ON` clause correct rather than merely plausible.
#[tokio::test]
#[ignore = "needs PLINTH_TEST_PG_URL; run with --ignored"]
async fn pg_foreign_keys_returns_every_edge() {
    let Some(d) = connect(false).await else { return };
    let schema = scratch_schema(&d, "fkgraph").await;
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
        "CREATE TABLE {schema}.customers (id bigint PRIMARY KEY);
         CREATE TABLE {schema}.regions (country text, city text, PRIMARY KEY (country, city));
         CREATE TABLE {schema}.orders (
           id bigint PRIMARY KEY,
           customer_id bigint REFERENCES {schema}.customers(id),
           country text, city text,
           CONSTRAINT orders_region_fkey FOREIGN KEY (country, city) REFERENCES {schema}.regions (country, city)
         );"
    )))
    .execute(d.pool())
    .await
    .expect("fixture");

    let edges: Vec<_> = d
        .foreign_keys()
        .await
        .expect("foreign_keys")
        .into_iter()
        .filter(|e| e.from.schema.as_deref() == Some(schema.as_str()))
        .collect();

    let simple = edges.iter().find(|e| e.from_columns == ["customer_id"]).expect("customer edge");
    assert_eq!(simple.from.name, "orders");
    assert_eq!(simple.to.name, "customers");
    assert_eq!(simple.to_columns, ["id"]);
    assert!(!simple.inferred, "a declared constraint is never marked inferred");

    let composite = edges.iter().find(|e| e.from_columns.len() == 2).expect("composite edge");
    assert_eq!(composite.from_columns, ["country", "city"], "column order preserved");
    assert_eq!(composite.to_columns, ["country", "city"]);
    assert_eq!(composite.name.as_deref(), Some("orders_region_fkey"));

    drop_schema(&d, &schema).await;
}

/// PLAN-5 §3.2: a `vector` column must arrive as a typed, parseable cell —
/// not `<unknown>`, and not a truncated blob. The UI's whole job is to keep
/// 1,536 numbers off the screen, which it can only do if it gets them.
#[tokio::test]
#[ignore = "needs PLINTH_TEST_PG_URL and the pgvector extension; run with --ignored"]
async fn pg_vector_columns_decode_as_text() {
    let Some(d) = connect(false).await else { return };
    if sqlx::raw_sql("CREATE EXTENSION IF NOT EXISTS vector").execute(d.pool()).await.is_err() {
        eprintln!("pgvector not available — skipping");
        return;
    }
    let schema = scratch_schema(&d, "vec").await;
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
        "CREATE TABLE {schema}.docs (id int PRIMARY KEY, embedding vector(3), half halfvec(3));
         INSERT INTO {schema}.docs VALUES (1, '[0.1,0.2,0.3]', '[1,2,3]');"
    )))
    .execute(d.pool())
    .await
    .expect("fixture");

    let m = d
        .execute(&format!("SELECT id, embedding, half FROM {schema}.docs"), &QueryOpts::default())
        .await
        .expect("select");

    let (ei, ecol) = col(&m, "embedding");
    assert_eq!(ecol.logical, LogicalType::Vector, "vector must be its own logical type");
    assert_eq!(ecol.wire, WireKind::String);
    assert_eq!(m.rows[0][ei], Cell::String("[0.1,0.2,0.3]".into()), "the text form arrives intact");

    let (hi, hcol) = col(&m, "half");
    assert_eq!(hcol.logical, LogicalType::Vector, "halfvec too");
    assert_eq!(m.rows[0][hi], Cell::String("[1,2,3]".into()));

    drop_schema(&d, &schema).await;
}

/// PLAN-6/7 territory: "did that migration run on staging?". Two live
/// databases, real drift, and a migration that must be additive.
#[tokio::test]
#[ignore = "needs PLINTH_TEST_PG_URL and PLINTH_TEST_PG_URL_B; run with --ignored"]
async fn pg_schema_diff_finds_real_drift_and_writes_the_migration() {
    let (Some(left), Ok(right_url)) = (connect(false).await, std::env::var("PLINTH_TEST_PG_URL_B")) else {
        eprintln!("needs both URLs — skipping");
        return;
    };
    let right = PostgresDriver::connect(
        PgConnectOptions::from_str(&right_url).expect("valid PLINTH_TEST_PG_URL_B"),
        false,
        SessionLimits::default(),
    )
    .await
    .expect("connect b");

    let l = left.schema_snapshot().await.expect("left snapshot");
    let r = right.schema_snapshot().await.expect("right snapshot");
    let diff = plinth_core::diff::compare(&l, &r, "local", "staging");

    let orders = diff
        .tables
        .iter()
        .find(|t| t.table.name == "orders")
        .expect("orders is on both sides");
    assert_eq!(orders.status, DiffStatus::Changed);

    // total: numeric locally, integer on staging.
    let total = orders.columns.iter().find(|c| c.name == "total").expect("total column");
    assert_eq!(total.status, DiffStatus::Changed);
    assert_eq!(total.changes, vec!["type"], "a widened type, not a rewrite");

    // metadata exists locally only.
    let metadata = orders.columns.iter().find(|c| c.name == "metadata").expect("metadata column");
    assert_eq!(metadata.status, DiffStatus::Added);

    // legacy_imports is on staging only.
    let legacy = diff.tables.iter().find(|t| t.table.name == "legacy_imports").expect("legacy table");
    assert_eq!(legacy.status, DiffStatus::Removed);

    let sql = plinth_core::diff::migration_sql(&diff, DriverKind::Postgres);
    assert!(sql.contains("BEGIN;") && sql.trim_end().ends_with("COMMIT;"));
    assert!(sql.contains(r#"ADD COLUMN IF NOT EXISTS "metadata""#), "additive change is runnable");
    assert!(sql.contains(r#"-- DROP TABLE "public"."legacy_imports";"#), "a drop is commented out");
    println!("--- generated migration ---\n{sql}");
}
