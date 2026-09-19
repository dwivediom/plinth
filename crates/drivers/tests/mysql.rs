//! MySQL integration tests. They need a live server:
//!
//! ```sh
//! PLINTH_TEST_MYSQL_URL=mysql://user:pass@localhost/db cargo test -p plinth-drivers --test mysql -- --ignored
//! ```
//!
//! Tables are created in the URL's database with a `plinth_t_` prefix.

use plinth_core::*;
use plinth_drivers::MysqlDriver;
use serde_json::json;
use sqlx::mysql::MySqlConnectOptions;
use std::collections::BTreeMap;
use std::str::FromStr;
use std::time::Duration;

fn url() -> Option<String> {
    std::env::var("PLINTH_TEST_MYSQL_URL").ok().filter(|u| !u.is_empty())
}

async fn connect(read_only: bool) -> Option<MysqlDriver> {
    let url = url()?;
    let opts = MySqlConnectOptions::from_str(&url).expect("valid PLINTH_TEST_MYSQL_URL");
    Some(MysqlDriver::connect(opts, read_only, SessionLimits::default()).await.expect("connect"))
}

async fn run(d: &MysqlDriver, sql: &str) {
    for stmt in sql.split(';').map(str::trim).filter(|s| !s.is_empty()) {
        sqlx::raw_sql(sqlx::AssertSqlSafe(stmt.to_string())).execute(d.pool()).await.unwrap_or_else(|e| panic!("{stmt}: {e}"));
    }
}

fn col<'a>(m: &'a Materialized, name: &str) -> (usize, &'a ColumnDesc) {
    m.columns.iter().enumerate().find(|(_, c)| c.name == name).unwrap_or_else(|| panic!("column {name}"))
}

#[tokio::test]
#[ignore = "needs PLINTH_TEST_MYSQL_URL; run with --ignored"]
async fn mysql_boundary_values_follow_wire_rules() {
    let Some(d) = connect(false).await else { return };
    run(
        &d,
        "DROP TABLE IF EXISTS plinth_t_types;
         CREATE TABLE plinth_t_types (
            id bigint PRIMARY KEY, u bigint unsigned, ti tinyint, b1 tinyint(1), n decimal(30,4), f double, f4 float,
            t text, vc varchar(10), bin varbinary(8), j json, dt datetime(6), ts timestamp NULL, d date, tm time(3), y year, bits bit(4), e enum('a','b')
         );
         INSERT INTO plinth_t_types VALUES
           (-9223372036854775808, 18446744073709551615, -128, 1, '10000000000000.0001', 0.1, 0.1, '', 'x', X'00FF10', '{\"a\":[1,2,{\"b\":null}]}',
            '2024-03-09 01:02:03.000001', '2024-03-09 01:02:03', '9999-12-31', '-838:59:58.999', 2024, b'1010', 'b'),
           (9223372036854775807, 0, 127, 0, '-0.0001', -1.5, NULL, 'grin 😀', NULL, X'', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);",
    )
    .await;

    let m = d.execute("SELECT * FROM plinth_t_types ORDER BY id", &QueryOpts::default()).await.expect("execute");
    assert_eq!(m.rows.len(), 2);
    let r1 = &m.rows[0];
    let r2 = &m.rows[1];

    let (id, id_desc) = col(&m, "id");
    assert_eq!((id_desc.logical, id_desc.wire, id_desc.data_type.as_str()), (LogicalType::Int, WireKind::String, "bigint"));
    assert_eq!(r1[id], json!("-9223372036854775808"));
    assert_eq!(r2[id], json!("9223372036854775807"));
    let (u, u_desc) = col(&m, "u");
    assert_eq!((u_desc.logical, u_desc.data_type.as_str()), (LogicalType::Int, "bigint unsigned"));
    assert_eq!(r1[u], json!("18446744073709551615"));
    assert_eq!(r1[col(&m, "ti").0], json!("-128"));
    let (b1, b1_desc) = col(&m, "b1");
    assert_eq!(b1_desc.logical, LogicalType::Bool);
    assert_eq!(r1[b1], json!(true));
    assert_eq!(r2[b1], json!(false));
    let (n, n_desc) = col(&m, "n");
    assert_eq!((n_desc.logical, n_desc.wire), (LogicalType::Decimal, WireKind::String));
    assert_eq!(r1[n], json!("10000000000000.0001"));
    assert_eq!(r2[n], json!("-0.0001"));
    let (f, f_desc) = col(&m, "f");
    assert_eq!(f_desc.wire, WireKind::Number);
    assert_eq!(r1[f], json!(0.1));
    assert_eq!(r2[f], json!(-1.5));
    assert_eq!(r1[col(&m, "f4").0].to_string(), "0.1");
    assert_eq!(r2[col(&m, "f4").0], Cell::Null);
    assert_eq!(r1[col(&m, "t").0], json!(""));
    assert_eq!(r2[col(&m, "t").0], json!("grin 😀"));
    assert_eq!(r2[col(&m, "vc").0], Cell::Null);
    assert_eq!(r1[col(&m, "bin").0], json!("AP8Q"));
    assert_eq!(r2[col(&m, "bin").0], json!(""));
    let (j, j_desc) = col(&m, "j");
    assert_eq!(j_desc.wire, WireKind::Json);
    assert_eq!(r1[j], json!({"a": [1, 2, {"b": null}]}));
    assert_eq!(r1[col(&m, "dt").0], json!("2024-03-09T01:02:03.000001"));
    assert_eq!(r1[col(&m, "ts").0], json!("2024-03-09T01:02:03+00:00"));
    assert_eq!(r1[col(&m, "d").0], json!("9999-12-31"));
    // MySQL's TIME runs -838:59:59 to 838:59:59, and that bound is whole
    // seconds even on a TIME(3): '-838:59:59.5' is rejected outright. This is
    // the largest magnitude that still carries a fraction, which is the pair
    // of things worth testing at once.
    assert_eq!(r1[col(&m, "tm").0], json!("-838:59:58.999"));
    assert_eq!(r1[col(&m, "y").0], json!("2024"));
    assert_eq!(r1[col(&m, "bits").0], json!("10"));
    assert_eq!(r1[col(&m, "e").0], json!("b"));

    run(&d, "DROP TABLE plinth_t_types").await;
}

#[tokio::test]
#[ignore = "needs PLINTH_TEST_MYSQL_URL; run with --ignored"]
async fn mysql_introspection() {
    let Some(d) = connect(false).await else { return };
    run(
        &d,
        "DROP TABLE IF EXISTS plinth_t_child; DROP TABLE IF EXISTS plinth_t_parent; DROP VIEW IF EXISTS plinth_t_view;
         CREATE TABLE plinth_t_parent (pid bigint PRIMARY KEY, label varchar(20) NOT NULL DEFAULT 'x');
         CREATE TABLE plinth_t_child (
            cid int AUTO_INCREMENT PRIMARY KEY, pid bigint NOT NULL, code varchar(8) UNIQUE, amount decimal(19,4),
            CONSTRAINT fk_child_parent FOREIGN KEY (pid) REFERENCES plinth_t_parent(pid),
            INDEX child_pid_idx (pid, code)
         );
         CREATE VIEW plinth_t_view AS SELECT pid, label FROM plinth_t_parent;
         INSERT INTO plinth_t_parent VALUES (1, 'one'), (2, 'two'), (3, 'three');
         ANALYZE TABLE plinth_t_parent;",
    )
    .await;

    let idx = d.schema_index().await.expect("schema_index");
    let db = d.current_database();
    assert!(
        idx.schemas.iter().any(|s| s.name == "information_schema" && s.is_system),
        "information_schema missing or not flagged system; SHOW DATABASES gave: {:?}",
        idx.schemas.iter().map(|s| (&s.name, s.is_system)).collect::<Vec<_>>()
    );
    let cur = idx.schemas.iter().find(|s| s.name == db).expect("current db listed");
    assert!(!cur.is_system);
    let find = |n: &str| cur.objects.iter().find(|o| o.name == n).unwrap_or_else(|| panic!("{n}"));
    assert_eq!(find("plinth_t_parent").kind, ObjectKind::Table);
    assert_eq!(find("plinth_t_parent").row_estimate, Some(3));
    assert_eq!(find("plinth_t_view").kind, ObjectKind::View);
    assert!(idx.schemas.iter().filter(|s| s.name != db).all(|s| s.objects.is_empty()));
    assert!(idx.columns.iter().any(|c| c.schema == db && c.table == "plinth_t_child" && c.column == "amount"));

    let t = d.describe_table(&TableRef { schema: None, name: "plinth_t_child".into() }).await.expect("describe");
    assert_eq!(t.table.schema.as_deref(), Some(db.as_str()));
    assert_eq!(t.primary_key, vec!["cid".to_string()]);
    let types: Vec<(&str, &str, bool)> = t.columns.iter().map(|c| (c.name.as_str(), c.data_type.as_str(), c.nullable)).collect();
    assert_eq!(types, vec![("cid", "int", false), ("pid", "bigint", false), ("code", "varchar(8)", true), ("amount", "decimal(19,4)", true)]);
    assert_eq!(t.columns[0].default.as_deref(), Some("AUTO_INCREMENT"));
    assert_eq!(t.columns[3].logical, LogicalType::Decimal);
    assert_eq!(t.columns.iter().map(|c| c.ordinal).collect::<Vec<_>>(), vec![1, 2, 3, 4]);
    assert_eq!(t.foreign_keys.len(), 1);
    assert_eq!(t.foreign_keys[0].name.as_deref(), Some("fk_child_parent"));
    assert_eq!(t.foreign_keys[0].columns, vec!["pid".to_string()]);
    assert_eq!(t.foreign_keys[0].ref_table.name, "plinth_t_parent");
    assert_eq!(t.foreign_keys[0].ref_columns, vec!["pid".to_string()]);
    assert!(t.indexes[0].primary);
    assert_eq!(t.indexes[0].columns, vec!["cid".to_string()]);
    let named = t.indexes.iter().find(|i| i.name == "child_pid_idx").expect("child_pid_idx");
    assert_eq!(named.columns, vec!["pid".to_string(), "code".to_string()]);
    assert!(!named.unique);
    assert!(t.indexes.iter().any(|i| i.unique && !i.primary && i.columns == vec!["code".to_string()]));
    assert!(t.ddl.unwrap_or_default().starts_with("CREATE TABLE `plinth_t_child`"));

    let v = d.describe_table(&TableRef { schema: None, name: "plinth_t_view".into() }).await.expect("view");
    assert_eq!(v.kind, ObjectKind::View);
    let parent = TableRef { schema: None, name: "plinth_t_parent".into() };
    assert_eq!(d.count(&parent, true).await.expect("exact"), 3);
    assert_eq!(d.count(&parent, false).await.expect("estimate"), 3);
    assert!(d.list_databases().await.expect("dbs").contains(&db));
    let version = d.server_version().await.expect("version");
    assert!(version.starts_with("MySQL ") || version.starts_with("MariaDB "), "{version}");
    d.ping().await.expect("ping");

    run(&d, "DROP VIEW plinth_t_view; DROP TABLE plinth_t_child; DROP TABLE plinth_t_parent").await;
}

#[tokio::test]
#[ignore = "needs PLINTH_TEST_MYSQL_URL; run with --ignored"]
async fn mysql_execute_apply_and_read_only() {
    let Some(d) = connect(false).await else { return };
    run(
        &d,
        "DROP TABLE IF EXISTS plinth_t_orders;
         CREATE TABLE plinth_t_orders (id bigint PRIMARY KEY, amount decimal(19,4), meta json, note text);
         INSERT INTO plinth_t_orders VALUES (1, 1.5, '{}', 'a'), (2, 2.5, NULL, 'b'), (3, 3.5, NULL, 'c');",
    )
    .await;
    let table = TableRef { schema: None, name: "plinth_t_orders".into() };
    let schema = d.describe_table(&table).await.expect("describe");

    let m = d.execute("SELECT id FROM plinth_t_orders ORDER BY id", &QueryOpts { limit: Some(2), ..QueryOpts::default() }).await.expect("select");
    assert_eq!(m.rows.len(), 2);
    assert!(m.truncated);
    let m = d.execute("UPDATE plinth_t_orders SET note = 'z' WHERE id > 1", &QueryOpts::default()).await.expect("update");
    assert_eq!(m.rows_affected, Some(2));

    let q = TableQuery {
        filters: vec![Filter { column: "amount".into(), op: FilterOp::Gt, value: Some("2".into()) }],
        sort: vec![Sort { column: "id".into(), dir: SortDir::Desc }],
        limit: Some(10),
        offset: None,
    };
    let m = d.execute(&d.build_table_select(&table, &schema, &q), &QueryOpts::default()).await.expect("view select");
    assert_eq!(m.rows.iter().map(|r| r[0].clone()).collect::<Vec<_>>(), vec![json!("3"), json!("2")]);

    let changes = ChangeSet {
        table: None,
        updates: vec![
            CellChange { pk: BTreeMap::from([("id".to_string(), json!("1"))]), column: "amount".into(), value: json!("10000000000000.0001") },
            CellChange { pk: BTreeMap::from([("id".to_string(), json!("1"))]), column: "meta".into(), value: json!({"k": [1, "v"]}) },
        ],
        inserts: vec![RowInsert { values: BTreeMap::from([("id".to_string(), json!("4")), ("note".to_string(), json!("it's \\ ok"))]) }],
        deletes: vec![RowDelete { pk: BTreeMap::from([("id".to_string(), json!("3"))]) }],
    };
    let stmts = d.render_changes(&schema, &changes).expect("render");
    assert_eq!(d.apply(&stmts).await.expect("apply"), 4);
    let m = d.execute("SELECT id, amount, meta, note FROM plinth_t_orders ORDER BY id", &QueryOpts::default()).await.expect("select");
    assert_eq!(m.rows[0][1], json!("10000000000000.0001"));
    assert_eq!(m.rows[0][2], json!({"k": [1, "v"]}));
    assert_eq!(m.rows.last().map(|r| r[3].clone()), Some(json!("it's \\ ok")));

    let err = d.apply(&["DELETE FROM plinth_t_orders WHERE id = 1".to_string(), "INSERT INTO plinth_t_nope VALUES (1)".to_string()]).await.expect_err("rollback");
    assert_eq!(err.code, "driver");
    assert_eq!(d.count(&table, true).await.expect("count"), 3);

    let ro = QueryOpts { read_only: true, ..QueryOpts::default() };
    let err = d.execute("INSERT INTO plinth_t_orders (id) VALUES (99)", &ro).await.expect_err("read only");
    assert_eq!(err.detail.as_deref(), Some("25006"), "{}", err.message);
    let m = d.execute("SELECT COUNT(*) FROM plinth_t_orders", &ro).await.expect("read");
    assert_eq!(m.rows[0][0], json!("3"));

    let ro_driver = connect(true).await.expect("ro driver");
    let err = ro_driver.execute("DELETE FROM plinth_t_orders", &QueryOpts::default()).await.expect_err("read only session");
    assert_eq!(err.detail.as_deref(), Some("25006"), "{}", err.message);
    ro_driver.close().await;

    run(&d, "DROP TABLE plinth_t_orders").await;
}

#[tokio::test]
#[ignore = "needs PLINTH_TEST_MYSQL_URL; run with --ignored"]
async fn mysql_cancel_and_timeout() {
    let Some(d) = connect(false).await else { return };
    let d = std::sync::Arc::new(d);
    let runner = {
        let d = d.clone();
        tokio::spawn(async move { d.execute("SELECT SLEEP(10)", &QueryOpts { timeout_ms: None, ..QueryOpts::default() }).await })
    };
    tokio::time::sleep(Duration::from_millis(300)).await;
    d.cancel().await.expect("cancel");
    let out = runner.await.expect("join");
    // MySQL reports a killed query either as an error (ER_QUERY_INTERRUPTED) or, for SLEEP(), as a result of 1.
    match out {
        Ok(m) => assert_eq!(m.rows[0][0], json!("1")),
        Err(e) => assert_eq!(e.detail.as_deref(), Some("70100"), "{}", e.message),
    }

    let err = d.execute("SELECT SLEEP(10)", &QueryOpts { timeout_ms: Some(200), ..QueryOpts::default() }).await.expect_err("timeout");
    assert!(err.message.contains("timed out"));
    d.ping().await.expect("pool still usable");
}
