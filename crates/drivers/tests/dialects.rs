//! Dialect rendering snapshots that need no server: Postgres casts, MySQL
//! backticks and backslash escaping.

use plinth_core::*;
use plinth_drivers::sql;
use serde_json::json;
use std::collections::BTreeMap;

fn schema(kind: DriverKind) -> TableSchema {
    let col = |name: &str, data_type: &str, pk: bool| ColumnInfo {
        name: name.into(),
        data_type: data_type.into(),
        logical: plinth_drivers::value::logical_from_raw(kind, data_type),
        nullable: !pk,
        default: None,
        is_primary_key: pk,
        ordinal: 0,
    };
    let (int, num, ts, js, by, arr) = match kind {
        DriverKind::Postgres => ("bigint", "numeric(19,4)", "timestamp with time zone", "jsonb", "bytea", "text[]"),
        DriverKind::Mysql => ("bigint unsigned", "decimal(19,4)", "datetime", "json", "varbinary(16)", "text"),
        DriverKind::Sqlite => ("INTEGER", "NUMERIC", "DATETIME", "JSON", "BLOB", "TEXT"),
    };
    TableSchema {
        table: TableRef { schema: Some(if kind == DriverKind::Mysql { "shop".into() } else { "public".into() }), name: "orders".into() },
        kind: ObjectKind::Table,
        columns: vec![
            col("id", int, true),
            col("amount", num, false),
            col("note", "text", false),
            col("paid", "boolean", false),
            col("created", ts, false),
            col("meta", js, false),
            col("blob", by, false),
            col("tags", arr, false),
            col("ratio", if kind == DriverKind::Mysql { "double" } else { "float8" }, false),
        ],
        primary_key: vec!["id".into()],
        foreign_keys: vec![],
        indexes: vec![],
        ddl: None,
        row_estimate: None,
    }
}

fn pk(id: &str) -> BTreeMap<String, Cell> {
    BTreeMap::from([("id".to_string(), json!(id))])
}

#[test]
fn postgres_select_uses_casts() {
    let s = schema(DriverKind::Postgres);
    let q = TableQuery {
        filters: vec![
            Filter { column: "amount".into(), op: FilterOp::Gte, value: Some("10.5".into()) },
            Filter { column: "amount".into(), op: FilterOp::Eq, value: Some("NaN".into()) },
            Filter { column: "created".into(), op: FilterOp::Lt, value: Some("2024-01-01".into()) },
            Filter { column: "note".into(), op: FilterOp::NotLike, value: Some("%x%".into()) },
            Filter { column: "id".into(), op: FilterOp::Like, value: Some("12%".into()) },
            Filter { column: "paid".into(), op: FilterOp::Eq, value: Some("f".into()) },
            Filter { column: "meta".into(), op: FilterOp::Neq, value: Some("{}".into()) },
            Filter { column: "id".into(), op: FilterOp::In, value: Some("1,x".into()) },
        ],
        sort: vec![Sort { column: "created".into(), dir: SortDir::Desc }],
        limit: None,
        offset: Some(0),
    };
    let out = sql::build_table_select(DriverKind::Postgres, &s.table, &s, &q);
    assert_eq!(
        out,
        "SELECT \"id\", \"amount\", \"note\", \"paid\", \"created\", \"meta\", \"blob\", \"tags\", \"ratio\" FROM \"public\".\"orders\" \
         WHERE \"amount\" >= 10.5 AND \"amount\" = 'NaN'::numeric(19,4) AND \"created\" < '2024-01-01'::timestamp with time zone \
         AND \"note\" NOT LIKE '%x%' AND CAST(\"id\" AS TEXT) LIKE '12%' AND \"paid\" = FALSE AND \"meta\" <> '{}' \
         AND \"id\" IN (1, 'x'::bigint) ORDER BY \"created\" DESC LIMIT 1000"
    );
}

#[test]
fn postgres_changes_carry_casts() {
    let s = schema(DriverKind::Postgres);
    let changes = ChangeSet {
        table: None,
        updates: vec![
            CellChange { pk: pk("9007199254740993"), column: "amount".into(), value: json!("10000000000000.0001") },
            CellChange { pk: pk("1"), column: "meta".into(), value: json!({"a": 1}) },
            CellChange { pk: pk("1"), column: "paid".into(), value: json!(true) },
            CellChange { pk: pk("1"), column: "ratio".into(), value: json!(0.5) },
            CellChange { pk: pk("1"), column: "blob".into(), value: json!("AP8=") },
            CellChange { pk: pk("1"), column: "tags".into(), value: json!(["a", "b'c"]) },
            CellChange { pk: pk("1"), column: "note".into(), value: Cell::Null },
        ],
        inserts: vec![RowInsert { values: BTreeMap::from([("id".to_string(), json!("2")), ("note".to_string(), json!("hi"))]) }],
        deletes: vec![RowDelete { pk: pk("3") }],
    };
    let out = sql::render_changes(DriverKind::Postgres, &s, &changes).expect("render");
    assert_eq!(
        out,
        vec![
            "UPDATE \"public\".\"orders\" SET \"amount\" = '10000000000000.0001'::numeric(19,4) WHERE \"id\" = '9007199254740993'::bigint",
            "UPDATE \"public\".\"orders\" SET \"meta\" = '{\"a\":1}'::jsonb WHERE \"id\" = '1'::bigint",
            "UPDATE \"public\".\"orders\" SET \"paid\" = TRUE::boolean WHERE \"id\" = '1'::bigint",
            "UPDATE \"public\".\"orders\" SET \"ratio\" = 0.5::float8 WHERE \"id\" = '1'::bigint",
            "UPDATE \"public\".\"orders\" SET \"blob\" = '\\x00ff'::bytea WHERE \"id\" = '1'::bigint",
            "UPDATE \"public\".\"orders\" SET \"tags\" = ARRAY['a', 'b''c']::text[] WHERE \"id\" = '1'::bigint",
            "UPDATE \"public\".\"orders\" SET \"note\" = NULL WHERE \"id\" = '1'::bigint",
            "INSERT INTO \"public\".\"orders\" (\"id\", \"note\") VALUES ('2'::bigint, 'hi'::text)",
            "DELETE FROM \"public\".\"orders\" WHERE \"id\" = '3'::bigint",
        ]
    );
}

#[test]
fn mysql_rendering() {
    let s = schema(DriverKind::Mysql);
    let q = TableQuery {
        filters: vec![
            Filter { column: "note".into(), op: FilterOp::Eq, value: Some("back\\slash 'q'".into()) },
            Filter { column: "id".into(), op: FilterOp::Gt, value: Some("18446744073709551615".into()) },
            Filter { column: "paid".into(), op: FilterOp::Eq, value: Some("1".into()) },
        ],
        sort: vec![],
        limit: Some(25),
        offset: Some(50),
    };
    let out = sql::build_table_select(DriverKind::Mysql, &s.table, &s, &q);
    assert_eq!(
        out,
        "SELECT `id`, `amount`, `note`, `paid`, `created`, `meta`, `blob`, `tags`, `ratio` FROM `shop`.`orders` \
         WHERE `note` = 'back\\\\slash ''q''' AND `id` > 18446744073709551615 AND `paid` = TRUE LIMIT 25 OFFSET 50"
    );
    let changes = ChangeSet {
        table: None,
        updates: vec![
            CellChange { pk: pk("1"), column: "amount".into(), value: json!("1.2345") },
            CellChange { pk: pk("1"), column: "blob".into(), value: json!("AP8=") },
            CellChange { pk: pk("1"), column: "meta".into(), value: json!([1, 2]) },
        ],
        inserts: vec![],
        deletes: vec![RowDelete { pk: pk("2") }],
    };
    let out = sql::render_changes(DriverKind::Mysql, &s, &changes).expect("render");
    assert_eq!(
        out,
        vec![
            "UPDATE `shop`.`orders` SET `amount` = '1.2345' WHERE `id` = '1'",
            "UPDATE `shop`.`orders` SET `blob` = X'00ff' WHERE `id` = '1'",
            "UPDATE `shop`.`orders` SET `meta` = '[1,2]' WHERE `id` = '1'",
            "DELETE FROM `shop`.`orders` WHERE `id` = '2'",
        ]
    );
}

#[test]
fn missing_pk_value_is_rejected() {
    let s = schema(DriverKind::Postgres);
    let changes = ChangeSet {
        table: None,
        updates: vec![CellChange { pk: BTreeMap::new(), column: "note".into(), value: json!("x") }],
        inserts: vec![],
        deletes: vec![],
    };
    let err = sql::render_changes(DriverKind::Postgres, &s, &changes).expect_err("missing pk value");
    assert_eq!(err.code, "invalid");
    assert!(err.message.contains("primary key"));
}
