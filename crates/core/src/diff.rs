//! Schema comparison and the migration it implies.
//!
//! "Did that migration run on staging?" is a question no GUI answers, so
//! people dump both schemas and run a line diff — which reports a column
//! order change as a rewrite and can't see a constraint at all. This compares
//! catalogues, not text: order never matters, and a type change is a type
//! change rather than two unrelated lines.
//!
//! Pure functions over two `SchemaSnapshot`s. No driver, no IO — so the rules
//! that matter (what counts as "changed", what the DDL says) are testable.

use crate::ipc::{
    ColumnDiff, ColumnSnapshot, DiffStatus, DiffSummary, DriverKind, IndexDiff, ObjectKind, SchemaDiff, SchemaSnapshot, TableDiff, TableRef,
    TableSnapshot,
};
use std::collections::BTreeMap;

fn key(t: &TableRef) -> String {
    match &t.schema {
        Some(s) => format!("{}.{}", s.to_ascii_lowercase(), t.name.to_ascii_lowercase()),
        None => t.name.to_ascii_lowercase(),
    }
}

/// Postgres spells the same type several ways depending on where you read it
/// from. `varchar(50)` and `character varying(50)` are not a schema change.
fn normalise_type(raw: &str) -> String {
    let t = raw.trim().to_ascii_lowercase();
    let t = t.replace("character varying", "varchar").replace("character", "char");
    let t = t.replace("timestamp without time zone", "timestamp").replace("timestamp with time zone", "timestamptz");
    let t = t.replace("time without time zone", "time").replace("time with time zone", "timetz");
    let t = t.replace("double precision", "float8").replace("boolean", "bool");
    t.replace(' ', "")
}

/// A default of `NULL` and no default at all are the same thing; so are
/// `nextval('t_id_seq')` written two ways in different catalogues.
fn normalise_default(d: Option<&str>) -> Option<String> {
    let d = d?.trim();
    if d.is_empty() || d.eq_ignore_ascii_case("null") {
        return None;
    }
    Some(d.to_ascii_lowercase().replace(' ', ""))
}

/// Compare `left` (the source of truth — usually local) against `right` (the
/// target — usually staging). "Added" means the migration must add it.
pub fn compare(left: &SchemaSnapshot, right: &SchemaSnapshot, left_label: &str, right_label: &str) -> SchemaDiff {
    let lefts: BTreeMap<String, &TableSnapshot> = left.tables.iter().map(|t| (key(&t.table), t)).collect();
    let rights: BTreeMap<String, &TableSnapshot> = right.tables.iter().map(|t| (key(&t.table), t)).collect();

    let mut tables = Vec::new();
    let mut summary = DiffSummary::default();

    let mut names: Vec<&String> = lefts.keys().chain(rights.keys()).collect();
    names.sort();
    names.dedup();

    for name in names {
        match (lefts.get(name), rights.get(name)) {
            (Some(l), None) => {
                summary.tables_added += 1;
                summary.columns_added += l.columns.len() as u32;
                tables.push(TableDiff {
                    table: l.table.clone(),
                    kind: l.kind,
                    status: DiffStatus::Added,
                    columns: l
                        .columns
                        .iter()
                        .map(|c| ColumnDiff { name: c.name.clone(), status: DiffStatus::Added, left: Some(c.clone()), right: None, changes: vec![] })
                        .collect(),
                    indexes: vec![],
                    primary_key_changed: false,
                });
            }
            (None, Some(r)) => {
                summary.tables_removed += 1;
                summary.columns_removed += r.columns.len() as u32;
                tables.push(TableDiff {
                    table: r.table.clone(),
                    kind: r.kind,
                    status: DiffStatus::Removed,
                    columns: r
                        .columns
                        .iter()
                        .map(|c| ColumnDiff { name: c.name.clone(), status: DiffStatus::Removed, left: None, right: Some(c.clone()), changes: vec![] })
                        .collect(),
                    indexes: vec![],
                    primary_key_changed: false,
                });
            }
            (Some(l), Some(r)) => {
                let (columns, counts) = compare_columns(l, r);
                let indexes = compare_indexes(l, r);
                let pk_changed = l.primary_key != r.primary_key;
                let changed = pk_changed
                    || columns.iter().any(|c| c.status != DiffStatus::Same)
                    || indexes.iter().any(|i| i.status != DiffStatus::Same);
                if changed {
                    summary.tables_changed += 1;
                    summary.columns_added += counts.0;
                    summary.columns_removed += counts.1;
                    summary.columns_changed += counts.2;
                }
                tables.push(TableDiff {
                    table: l.table.clone(),
                    kind: l.kind,
                    status: if changed { DiffStatus::Changed } else { DiffStatus::Same },
                    columns,
                    indexes,
                    primary_key_changed: pk_changed,
                });
            }
            (None, None) => unreachable!("name came from one of the two maps"),
        }
    }

    SchemaDiff { tables, left_label: left_label.to_string(), right_label: right_label.to_string(), summary }
}

/// Returns the column diffs and (added, removed, changed) counts.
fn compare_columns(left: &TableSnapshot, right: &TableSnapshot) -> (Vec<ColumnDiff>, (u32, u32, u32)) {
    let lefts: BTreeMap<String, &ColumnSnapshot> = left.columns.iter().map(|c| (c.name.to_ascii_lowercase(), c)).collect();
    let rights: BTreeMap<String, &ColumnSnapshot> = right.columns.iter().map(|c| (c.name.to_ascii_lowercase(), c)).collect();

    let mut names: Vec<&String> = lefts.keys().chain(rights.keys()).collect();
    names.sort();
    names.dedup();

    let mut out = Vec::new();
    let mut counts = (0, 0, 0);
    for name in names {
        match (lefts.get(name), rights.get(name)) {
            (Some(l), None) => {
                counts.0 += 1;
                out.push(ColumnDiff { name: l.name.clone(), status: DiffStatus::Added, left: Some((*l).clone()), right: None, changes: vec![] });
            }
            (None, Some(r)) => {
                counts.1 += 1;
                out.push(ColumnDiff { name: r.name.clone(), status: DiffStatus::Removed, left: None, right: Some((*r).clone()), changes: vec![] });
            }
            (Some(l), Some(r)) => {
                let mut changes = Vec::new();
                // Column *order* is deliberately not a difference: it is what
                // makes a text diff of two dumps unreadable.
                if normalise_type(&l.data_type) != normalise_type(&r.data_type) {
                    changes.push("type".to_string());
                }
                if l.nullable != r.nullable {
                    changes.push("nullability".to_string());
                }
                if normalise_default(l.default.as_deref()) != normalise_default(r.default.as_deref()) {
                    changes.push("default".to_string());
                }
                let status = if changes.is_empty() { DiffStatus::Same } else { DiffStatus::Changed };
                if status == DiffStatus::Changed {
                    counts.2 += 1;
                }
                out.push(ColumnDiff { name: l.name.clone(), status, left: Some((*l).clone()), right: Some((*r).clone()), changes });
            }
            (None, None) => unreachable!(),
        }
    }
    (out, counts)
}

fn compare_indexes(left: &TableSnapshot, right: &TableSnapshot) -> Vec<IndexDiff> {
    let lefts: BTreeMap<&str, _> = left.indexes.iter().map(|i| (i.name.as_str(), i)).collect();
    let rights: BTreeMap<&str, _> = right.indexes.iter().map(|i| (i.name.as_str(), i)).collect();
    let mut names: Vec<&&str> = lefts.keys().chain(rights.keys()).collect();
    names.sort();
    names.dedup();

    names
        .into_iter()
        .map(|name| match (lefts.get(name), rights.get(name)) {
            (Some(l), None) => IndexDiff { name: name.to_string(), status: DiffStatus::Added, left: Some((*l).clone()), right: None },
            (None, Some(r)) => IndexDiff { name: name.to_string(), status: DiffStatus::Removed, left: None, right: Some((*r).clone()) },
            (Some(l), Some(r)) => IndexDiff {
                name: name.to_string(),
                status: if l.definition.to_ascii_lowercase().replace(' ', "") == r.definition.to_ascii_lowercase().replace(' ', "") {
                    DiffStatus::Same
                } else {
                    DiffStatus::Changed
                },
                left: Some((*l).clone()),
                right: Some((*r).clone()),
            },
            (None, None) => unreachable!(),
        })
        .collect()
}

fn quote(driver: DriverKind, ident: &str) -> String {
    match driver {
        DriverKind::Mysql => format!("`{}`", ident.replace('`', "``")),
        _ => format!("\"{}\"", ident.replace('"', "\"\"")),
    }
}

fn qualified(driver: DriverKind, t: &TableRef) -> String {
    match &t.schema {
        Some(s) => format!("{}.{}", quote(driver, s), quote(driver, &t.name)),
        None => quote(driver, &t.name),
    }
}

/// The migration that makes `right` look like `left`.
///
/// Additive changes are emitted as runnable SQL; anything that destroys data —
/// dropping a column or a table, narrowing a type — is emitted **commented
/// out**, with the reason. A migration you have to un-comment is one you have
/// read.
pub fn migration_sql(diff: &SchemaDiff, driver: DriverKind) -> String {
    let guards = matches!(driver, DriverKind::Postgres);
    let mut out = vec![
        format!("-- Migration: make {} match {}.", diff.right_label, diff.left_label),
        "-- Generated by Plinth. Destructive statements are commented out on purpose —".to_string(),
        "-- read them, then un-comment the ones you mean.".to_string(),
        String::new(),
        "BEGIN;".to_string(),
        String::new(),
    ];

    for table in &diff.tables {
        let name = qualified(driver, &table.table);
        // A view's shape follows its query; there is no ALTER to write, and
        // its definition isn't in a column catalogue. Say so and move on.
        if !matches!(table.kind, ObjectKind::Table) {
            match table.status {
                DiffStatus::Added => out.push(format!("-- {name} is a {:?} that exists only in {} — recreate it from its definition.", table.kind, diff.left_label)),
                DiffStatus::Removed => out.push(format!("-- {name} is a {:?} that exists only in {}.", table.kind, diff.right_label)),
                DiffStatus::Changed => out.push(format!("-- {name} is a {:?} whose columns differ — recreate it from its definition.", table.kind)),
                DiffStatus::Same => {}
            }
            continue;
        }
        match table.status {
            DiffStatus::Same => continue,
            DiffStatus::Added => {
                let cols: Vec<String> = table
                    .columns
                    .iter()
                    .filter_map(|c| c.left.as_ref())
                    .map(|c| format!("  {} {}{}{}", quote(driver, &c.name), c.data_type, if c.nullable { "" } else { " NOT NULL" }, c.default.as_deref().map(|d| format!(" DEFAULT {d}")).unwrap_or_default()))
                    .collect();
                out.push(format!("CREATE TABLE {}{} (\n{}\n);", if guards { "IF NOT EXISTS " } else { "" }, name, cols.join(",\n")));
            }
            DiffStatus::Removed => {
                out.push(format!("-- {name} exists in {} but not in {} — dropping it destroys its data:", diff.right_label, diff.left_label));
                out.push(format!("-- DROP TABLE {name};"));
            }
            DiffStatus::Changed => {
                for column in &table.columns {
                    match column.status {
                        DiffStatus::Added => {
                            if let Some(c) = &column.left {
                                let nullable = if c.nullable { "" } else { " NOT NULL" };
                                let default = c.default.as_deref().map(|d| format!(" DEFAULT {d}")).unwrap_or_default();
                                if !c.nullable && c.default.is_none() {
                                    out.push(format!("-- {} is NOT NULL with no default; adding it to a non-empty table will fail:", c.name));
                                    out.push(format!("-- ALTER TABLE {name} ADD COLUMN {}{} {} NOT NULL;", if guards { "IF NOT EXISTS " } else { "" }, quote(driver, &c.name), c.data_type));
                                } else {
                                    out.push(format!("ALTER TABLE {name} ADD COLUMN {}{} {}{}{};", if guards { "IF NOT EXISTS " } else { "" }, quote(driver, &c.name), c.data_type, nullable, default));
                                }
                            }
                        }
                        DiffStatus::Removed => {
                            out.push(format!("-- {}.{} exists only in {} — dropping it destroys its data:", table.table.name, column.name, diff.right_label));
                            out.push(format!("-- ALTER TABLE {name} DROP COLUMN {};", quote(driver, &column.name)));
                        }
                        DiffStatus::Changed => {
                            let (Some(l), Some(r)) = (&column.left, &column.right) else { continue };
                            if column.changes.iter().any(|c| c == "type") {
                                out.push(format!("-- {} changes type: {} -> {}. Check this is widening before running it.", column.name, r.data_type, l.data_type));
                                match driver {
                                    DriverKind::Mysql => out.push(format!("ALTER TABLE {name} MODIFY COLUMN {} {};", quote(driver, &l.name), l.data_type)),
                                    _ => out.push(format!("ALTER TABLE {name} ALTER COLUMN {} TYPE {};", quote(driver, &l.name), l.data_type)),
                                }
                            }
                            if column.changes.iter().any(|c| c == "nullability") && !matches!(driver, DriverKind::Mysql) {
                                out.push(match l.nullable {
                                    true => format!("ALTER TABLE {name} ALTER COLUMN {} DROP NOT NULL;", quote(driver, &l.name)),
                                    // Going NOT NULL fails on existing nulls — say so rather than let it blow up mid-transaction.
                                    false => format!("-- existing NULLs will block this:\nALTER TABLE {name} ALTER COLUMN {} SET NOT NULL;", quote(driver, &l.name)),
                                });
                            }
                            if column.changes.iter().any(|c| c == "default") && !matches!(driver, DriverKind::Mysql) {
                                out.push(match &l.default {
                                    Some(d) => format!("ALTER TABLE {name} ALTER COLUMN {} SET DEFAULT {d};", quote(driver, &l.name)),
                                    None => format!("ALTER TABLE {name} ALTER COLUMN {} DROP DEFAULT;", quote(driver, &l.name)),
                                });
                            }
                        }
                        DiffStatus::Same => {}
                    }
                }
                for index in &table.indexes {
                    match (index.status, &index.left) {
                        (DiffStatus::Added, Some(l)) => out.push(format!("{};", l.definition.trim_end_matches(';'))),
                        (DiffStatus::Removed, _) => out.push(format!("-- DROP INDEX {};", quote(driver, &index.name))),
                        (DiffStatus::Changed, Some(l)) => {
                            out.push(format!("-- {} differs; recreate it:", index.name));
                            out.push(format!("-- DROP INDEX {};\n-- {};", quote(driver, &index.name), l.definition.trim_end_matches(';')));
                        }
                        _ => {}
                    }
                }
                if table.primary_key_changed {
                    out.push(format!("-- the primary key of {name} differs; changing one is never automatic."));
                }
            }
        }
    }

    out.push(String::new());
    out.push("COMMIT;".to_string());
    out.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::IndexSnapshot;

    fn col(name: &str, ty: &str, nullable: bool, default: Option<&str>, ordinal: i32) -> ColumnSnapshot {
        ColumnSnapshot { name: name.into(), data_type: ty.into(), nullable, default: default.map(str::to_string), ordinal }
    }

    fn view(name: &str, columns: Vec<ColumnSnapshot>) -> TableSnapshot {
        TableSnapshot { kind: ObjectKind::View, ..table(name, columns) }
    }

    fn table(name: &str, columns: Vec<ColumnSnapshot>) -> TableSnapshot {
        TableSnapshot {
            table: TableRef { schema: Some("public".into()), name: name.into() },
            kind: ObjectKind::Table,
            columns,
            primary_key: vec!["id".into()],
            indexes: vec![],
        }
    }

    fn snapshot(tables: Vec<TableSnapshot>) -> SchemaSnapshot {
        SchemaSnapshot { tables, foreign_keys: vec![], generated_at: String::new() }
    }

    #[test]
    fn column_order_is_not_a_difference() {
        let left = snapshot(vec![table("users", vec![col("id", "bigint", false, None, 1), col("email", "text", true, None, 2)])]);
        let right = snapshot(vec![table("users", vec![col("email", "text", true, None, 1), col("id", "bigint", false, None, 2)])]);
        let d = compare(&left, &right, "local", "staging");
        assert_eq!(d.tables[0].status, DiffStatus::Same, "a reordered dump is not a migration");
        assert_eq!(d.summary, DiffSummary::default());
    }

    #[test]
    fn spelling_of_a_type_is_not_a_difference() {
        let left = snapshot(vec![table("users", vec![col("name", "character varying(50)", true, None, 1)])]);
        let right = snapshot(vec![table("users", vec![col("name", "varchar(50)", true, None, 1)])]);
        assert_eq!(compare(&left, &right, "l", "r").tables[0].status, DiffStatus::Same);
    }

    #[test]
    fn finds_the_three_kinds_of_drift() {
        let left = snapshot(vec![
            table("users", vec![col("id", "bigint", false, None, 1), col("nickname", "text", true, None, 2), col("age", "bigint", true, None, 3)]),
            table("sessions", vec![col("id", "bigint", false, None, 1)]),
        ]);
        let right = snapshot(vec![table("users", vec![col("id", "bigint", false, None, 1), col("age", "integer", true, None, 2), col("legacy", "text", true, None, 3)])]);
        let d = compare(&left, &right, "local", "staging");

        assert_eq!(d.summary.tables_added, 1, "sessions is only local");
        assert_eq!(d.summary.columns_added, 2, "nickname, plus sessions.id");
        assert_eq!(d.summary.columns_removed, 1, "legacy is only on staging");
        assert_eq!(d.summary.columns_changed, 1, "age: integer -> bigint");

        let users = d.tables.iter().find(|t| t.table.name == "users").unwrap();
        let age = users.columns.iter().find(|c| c.name == "age").unwrap();
        assert_eq!(age.changes, vec!["type"]);
    }

    #[test]
    fn migration_is_additive_and_comments_out_what_destroys() {
        let left = snapshot(vec![table("users", vec![col("id", "bigint", false, None, 1), col("nickname", "text", true, None, 2)])]);
        let right = snapshot(vec![table("users", vec![col("id", "bigint", false, None, 1), col("legacy", "text", true, None, 2)])]);
        let sql = migration_sql(&compare(&left, &right, "local", "staging"), DriverKind::Postgres);

        assert!(sql.starts_with("-- Migration"), "it explains itself first");
        assert!(sql.contains("BEGIN;") && sql.trim_end().ends_with("COMMIT;"), "wrapped in a transaction");
        assert!(sql.contains(r#"ALTER TABLE "public"."users" ADD COLUMN IF NOT EXISTS "nickname" text;"#), "additive change runs");
        assert!(sql.contains(r#"-- ALTER TABLE "public"."users" DROP COLUMN "legacy";"#), "a drop is commented out");
    }

    /// A NOT NULL column with no default cannot be added to a table with rows.
    #[test]
    fn refuses_to_generate_a_statement_that_would_fail() {
        let left = snapshot(vec![table("users", vec![col("id", "bigint", false, None, 1), col("tenant_id", "bigint", false, None, 2)])]);
        let right = snapshot(vec![table("users", vec![col("id", "bigint", false, None, 1)])]);
        let sql = migration_sql(&compare(&left, &right, "local", "staging"), DriverKind::Postgres);
        assert!(sql.contains("-- tenant_id is NOT NULL with no default"));
        assert!(sql.contains("-- ALTER TABLE"), "the statement itself is commented out");
    }

    /// A view was being emitted as `CREATE TABLE`, which would have shadowed
    /// the real view on the target.
    #[test]
    fn a_view_is_never_created_as_a_table() {
        let left = snapshot(vec![view("customer_totals", vec![col("id", "bigint", true, None, 1)])]);
        let right = snapshot(vec![]);
        let sql = migration_sql(&compare(&left, &right, "local", "staging"), DriverKind::Postgres);
        assert!(!sql.contains("CREATE TABLE"), "a view must not become a table");
        assert!(sql.contains("recreate it from its definition"));
    }

    #[test]
    fn index_changes_are_named_not_rewritten() {
        let mut l = table("users", vec![col("id", "bigint", false, None, 1)]);
        let mut r = l.clone();
        l.indexes = vec![IndexSnapshot { name: "users_email_idx".into(), definition: "CREATE INDEX users_email_idx ON public.users (email)".into(), unique: false }];
        r.indexes = vec![IndexSnapshot { name: "users_email_idx".into(), definition: "CREATE UNIQUE INDEX users_email_idx ON public.users (email)".into(), unique: true }];
        let d = compare(&snapshot(vec![l]), &snapshot(vec![r]), "l", "r");
        assert_eq!(d.tables[0].indexes[0].status, DiffStatus::Changed);
        assert_eq!(d.tables[0].status, DiffStatus::Changed);
    }
}
