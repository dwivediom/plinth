//! The schema as a graph: nodes from the index, edges from declared foreign
//! keys plus a conservative guess for the databases that have none.
//!
//! Pure functions over `SchemaIndex` — no driver, no IO — so the inference
//! rules can be tested for precision, which is the only property that matters.
//! A wrong edge on a map is worse than a missing one, and a wrong edge in a
//! model's context becomes a wrong `JOIN`.

use crate::ipc::{GraphEdge, GraphNode, ObjectKind, SchemaIndex, SchemaGraph, TableRef};
use std::collections::HashMap;

/// Never let a guess run away on a wide schema.
const MAX_INFERRED: usize = 500;

/// Build the map. `declared` comes from `Driver::foreign_keys`; everything
/// else is derived from the index the app already has.
pub fn build(index: &SchemaIndex, declared: Vec<GraphEdge>) -> SchemaGraph {
    let mut nodes: Vec<GraphNode> = Vec::new();
    let mut columns_by_table: HashMap<(String, String), Vec<String>> = HashMap::new();

    for c in &index.columns {
        columns_by_table
            .entry((c.schema.clone(), c.table.clone()))
            .or_default()
            .push(c.column.clone());
    }

    for s in &index.schemas {
        if s.is_system {
            continue;
        }
        for o in &s.objects {
            if !matches!(o.kind, ObjectKind::Table | ObjectKind::View | ObjectKind::MaterializedView) {
                continue;
            }
            nodes.push(GraphNode {
                table: TableRef { schema: Some(o.schema.clone()), name: o.name.clone() },
                kind: o.kind,
                columns: columns_by_table.get(&(o.schema.clone(), o.name.clone())).cloned().unwrap_or_default(),
                row_estimate: o.row_estimate,
            });
        }
    }

    let mut edges = declared;
    edges.extend(infer(&nodes, &edges));
    SchemaGraph { nodes, edges, generated_at: crate::store::now_rfc3339() }
}

/// Guess the edges a database forgot to declare — the legacy-MySQL case, and
/// anything built by an ORM that skipped constraints.
///
/// The rule is deliberately narrow: `<base>_id` (or `<base>Id`) where a table
/// matching `<base>` exists and carries a plausible key column. Anything
/// looser produces edges nobody asked for.
fn infer(nodes: &[GraphNode], declared: &[GraphEdge]) -> Vec<GraphEdge> {
    // Lower-cased name → the node, preferring same-schema matches later.
    let mut by_name: HashMap<String, Vec<&GraphNode>> = HashMap::new();
    for n in nodes {
        by_name.entry(n.table.name.to_ascii_lowercase()).or_default().push(n);
    }

    let already: std::collections::HashSet<(String, String, String)> = declared
        .iter()
        .map(|e| (qualified(&e.from), e.from_columns.first().cloned().unwrap_or_default().to_ascii_lowercase(), qualified(&e.to)))
        .collect();

    let mut out = Vec::new();
    for node in nodes {
        // A view's columns are borrowed from its tables; guessing there would
        // double-draw every relationship.
        if node.kind != ObjectKind::Table {
            continue;
        }
        for column in &node.columns {
            if out.len() >= MAX_INFERRED {
                return out;
            }
            let Some(base) = fk_column_base(column) else { continue };
            let Some(target) = resolve_table(&by_name, &base, node.table.schema.as_deref()) else { continue };
            if target.table == node.table {
                continue; // self-reference by naming alone is too weak a signal
            }
            let Some(key) = key_column(target, &base) else { continue };
            let edge = GraphEdge {
                from: node.table.clone(),
                from_columns: vec![column.clone()],
                to: target.table.clone(),
                to_columns: vec![key],
                name: None,
                inferred: true,
            };
            let sig = (qualified(&edge.from), column.to_ascii_lowercase(), qualified(&edge.to));
            if already.contains(&sig) || out.iter().any(|e: &GraphEdge| {
                qualified(&e.from) == sig.0 && e.from_columns.first().map(|c| c.to_ascii_lowercase()) == Some(sig.1.clone())
            }) {
                continue;
            }
            out.push(edge);
        }
    }
    out
}

fn qualified(t: &TableRef) -> String {
    match &t.schema {
        Some(s) => format!("{}.{}", s.to_ascii_lowercase(), t.name.to_ascii_lowercase()),
        None => t.name.to_ascii_lowercase(),
    }
}

/// `customer_id` → `customer`, `customerId` → `customer`. Anything else, and
/// a bare `id`, is not a reference.
fn fk_column_base(column: &str) -> Option<String> {
    let lower = column.to_ascii_lowercase();
    if lower == "id" {
        return None;
    }
    if let Some(base) = lower.strip_suffix("_id") {
        return (!base.is_empty()).then(|| base.to_string());
    }
    if column.len() > 2 && column.ends_with("Id") {
        let base = &column[..column.len() - 2];
        return (!base.is_empty()).then(|| base.to_ascii_lowercase());
    }
    None
}

/// The table `base` might name, trying the obvious pluralisations. Same schema
/// wins; an ambiguous match across schemas is dropped rather than guessed.
fn resolve_table<'a>(by_name: &HashMap<String, Vec<&'a GraphNode>>, base: &str, schema: Option<&str>) -> Option<&'a GraphNode> {
    let mut candidates = vec![base.to_string(), format!("{base}s"), format!("{base}es")];
    if let Some(stem) = base.strip_suffix('y') {
        candidates.push(format!("{stem}ies"));
    }
    for candidate in candidates {
        let Some(matches) = by_name.get(&candidate) else { continue };
        if let Some(same) = matches.iter().find(|n| n.table.schema.as_deref() == schema) {
            return Some(same);
        }
        if matches.len() == 1 {
            return Some(matches[0]);
        }
    }
    None
}

/// The column the reference points at: `id`, or the table's own `<base>_id`.
fn key_column(target: &GraphNode, base: &str) -> Option<String> {
    let want = format!("{base}_id");
    target
        .columns
        .iter()
        .find(|c| c.eq_ignore_ascii_case("id"))
        .or_else(|| target.columns.iter().find(|c| c.eq_ignore_ascii_case(&want)))
        .cloned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::{ColumnRef, ObjectInfo, SchemaInfo};

    fn node(schema: &str, name: &str, columns: &[&str]) -> GraphNode {
        GraphNode {
            table: TableRef { schema: Some(schema.into()), name: name.into() },
            kind: ObjectKind::Table,
            columns: columns.iter().map(|c| c.to_string()).collect(),
            row_estimate: None,
        }
    }

    #[test]
    fn infers_the_obvious_reference() {
        let nodes = vec![node("public", "customers", &["id", "name"]), node("public", "orders", &["id", "customer_id"])];
        let edges = infer(&nodes, &[]);
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].from.name, "orders");
        assert_eq!(edges[0].from_columns, vec!["customer_id"]);
        assert_eq!(edges[0].to.name, "customers");
        assert_eq!(edges[0].to_columns, vec!["id"]);
        assert!(edges[0].inferred);
    }

    #[test]
    fn camel_case_and_singular_tables_resolve() {
        let nodes = vec![node("public", "customer", &["id"]), node("public", "orders", &["customerId"])];
        assert_eq!(infer(&nodes, &[]).len(), 1);
    }

    /// Precision matters more than recall: a guess nobody can justify is worse
    /// than a blank spot on the map.
    #[test]
    fn declines_what_it_cannot_justify() {
        // No such table.
        let nodes = vec![node("public", "orders", &["id", "vendor_id"])];
        assert!(infer(&nodes, &[]).is_empty(), "no target table");

        // Target has no key column to point at.
        let nodes = vec![node("public", "customers", &["name"]), node("public", "orders", &["customer_id"])];
        assert!(infer(&nodes, &[]).is_empty(), "no key column");

        // Ambiguous across schemas.
        let nodes = vec![
            node("app", "customers", &["id"]),
            node("legacy", "customers", &["id"]),
            node("other", "orders", &["customer_id"]),
        ];
        assert!(infer(&nodes, &[]).is_empty(), "ambiguous target");

        // A plain `id` is not a reference to anything.
        let nodes = vec![node("public", "id", &["id"]), node("public", "orders", &["id"])];
        assert!(infer(&nodes, &[]).is_empty(), "`id` is not a foreign key");
    }

    #[test]
    fn never_duplicates_a_declared_edge() {
        let nodes = vec![node("public", "customers", &["id"]), node("public", "orders", &["customer_id"])];
        let declared = vec![GraphEdge {
            from: TableRef { schema: Some("public".into()), name: "orders".into() },
            from_columns: vec!["customer_id".into()],
            to: TableRef { schema: Some("public".into()), name: "customers".into() },
            to_columns: vec!["id".into()],
            name: Some("orders_customer_id_fkey".into()),
            inferred: false,
        }];
        assert!(infer(&nodes, &declared).is_empty());
    }

    #[test]
    fn build_keeps_tables_and_views_and_drops_system_schemas() {
        let index = SchemaIndex {
            schemas: vec![
                SchemaInfo {
                    name: "public".into(),
                    is_system: false,
                    objects: vec![
                        ObjectInfo { schema: "public".into(), name: "orders".into(), kind: ObjectKind::Table, row_estimate: Some(10) },
                        ObjectInfo { schema: "public".into(), name: "order_totals".into(), kind: ObjectKind::View, row_estimate: None },
                        ObjectInfo { schema: "public".into(), name: "seq".into(), kind: ObjectKind::Sequence, row_estimate: None },
                    ],
                },
                SchemaInfo {
                    name: "pg_catalog".into(),
                    is_system: true,
                    objects: vec![ObjectInfo { schema: "pg_catalog".into(), name: "pg_class".into(), kind: ObjectKind::Table, row_estimate: None }],
                },
            ],
            columns: vec![ColumnRef { schema: "public".into(), table: "orders".into(), column: "id".into() }],
            generated_at: String::new(),
        };
        let g = build(&index, vec![]);
        let names: Vec<&str> = g.nodes.iter().map(|n| n.table.name.as_str()).collect();
        assert_eq!(names, vec!["orders", "order_totals"]);
        assert_eq!(g.nodes[0].columns, vec!["id"]);
    }
}
