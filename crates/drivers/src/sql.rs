//! Dialect-aware SQL rendering shared by the three drivers: identifier
//! quoting, literal escaping, the data-view `SELECT` builder and the change
//! set renderer. Everything here is pure (no I/O) so it is unit-tested with
//! snapshots.

use base64::Engine as _;
use plinth_core::*;

/// Quote an identifier for the dialect (`"x"` / `` `x` ``), doubling any
/// embedded quote character.
pub fn quote_ident(kind: DriverKind, ident: &str) -> String {
    match kind {
        DriverKind::Mysql => format!("`{}`", ident.replace('`', "``")),
        DriverKind::Postgres | DriverKind::Sqlite => format!("\"{}\"", ident.replace('"', "\"\"")),
    }
}

pub fn quote_table(kind: DriverKind, table: &TableRef) -> String {
    match &table.schema {
        Some(s) if !s.is_empty() => format!("{}.{}", quote_ident(kind, s), quote_ident(kind, &table.name)),
        _ => quote_ident(kind, &table.name),
    }
}

/// Render a string as a quoted SQL literal with dialect-correct escaping.
/// Postgres and SQLite treat backslashes literally (standard_conforming_strings);
/// MySQL treats backslash as an escape character in its default SQL mode.
pub fn string_literal(kind: DriverKind, s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for ch in s.chars() {
        match (kind, ch) {
            (_, '\'') => out.push_str("''"),
            (DriverKind::Mysql, '\\') => out.push_str("\\\\"),
            (DriverKind::Mysql, '\0') => out.push_str("\\0"),
            (DriverKind::Postgres, '\0') => {} // PG text cannot hold NUL
            (_, c) => out.push(c),
        }
    }
    out.push('\'');
    out
}

fn bool_literal(kind: DriverKind, b: bool) -> String {
    match kind {
        DriverKind::Sqlite => if b { "1" } else { "0" }.to_string(),
        _ => if b { "TRUE" } else { "FALSE" }.to_string(),
    }
}

/// Render base64-encoded bytes as a binary literal.
fn bytes_literal(kind: DriverKind, b64: &str) -> Option<String> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    Some(match kind {
        DriverKind::Postgres => format!("'\\x{hex}'::bytea"),
        DriverKind::Mysql => format!("X'{hex}'"),
        DriverKind::Sqlite => format!("X'{hex}'"),
    })
}

/// Does `raw` look like a plain SQL numeric literal (`-12`, `3.5`, `1e9`)?
pub fn is_numeric_literal(raw: &str) -> bool {
    let s = raw.trim();
    if s.is_empty() {
        return false;
    }
    let s = s.strip_prefix(['-', '+']).unwrap_or(s);
    let (mantissa, exponent) = match s.split_once(['e', 'E']) {
        Some((m, e)) => (m, Some(e)),
        None => (s, None),
    };
    let (int_part, frac_part) = match mantissa.split_once('.') {
        Some((i, f)) => (i, Some(f)),
        None => (mantissa, None),
    };
    let digits = |p: &str| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit());
    let mantissa_ok = match frac_part {
        Some(f) => (digits(int_part) || int_part.is_empty()) && (digits(f) || (f.is_empty() && digits(int_part))),
        None => digits(int_part),
    };
    let exponent_ok = match exponent {
        Some(e) => digits(e.strip_prefix(['-', '+']).unwrap_or(e)),
        None => true,
    };
    mantissa_ok && exponent_ok
}

fn parse_bool(raw: &str) -> Option<bool> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "true" | "t" | "1" | "yes" | "y" | "on" => Some(true),
        "false" | "f" | "0" | "no" | "n" | "off" => Some(false),
        _ => None,
    }
}

/// Should a Postgres literal for this column carry an explicit `::type` cast
/// in a filter? Text-ish and JSON columns compare fine against an untyped
/// literal; everything else benefits from the cast (and gets a clear error
/// when the value does not parse).
fn pg_filter_cast_helps(logical: LogicalType) -> bool {
    !matches!(
        logical,
        LogicalType::Text | LogicalType::Unknown | LogicalType::Json | LogicalType::Array | LogicalType::Document | LogicalType::Bytes
    )
}

/// Render a filter value as a literal for the given column.
fn filter_literal(kind: DriverKind, col: Option<&ColumnInfo>, raw: &str) -> String {
    let logical = col.map(|c| c.logical).unwrap_or(LogicalType::Unknown);
    if logical.is_numeric() && is_numeric_literal(raw) {
        return raw.trim().to_string();
    }
    if logical == LogicalType::Bool {
        if let Some(b) = parse_bool(raw) {
            return bool_literal(kind, b);
        }
    }
    let lit = string_literal(kind, raw);
    match (kind, col) {
        (DriverKind::Postgres, Some(c)) if pg_filter_cast_helps(c.logical) => format!("{lit}::{}", c.data_type),
        _ => lit,
    }
}

/// `SELECT <cols> FROM <table> [WHERE …] [ORDER BY …] LIMIT n [OFFSET m]`.
pub fn build_table_select(kind: DriverKind, table: &TableRef, schema: &TableSchema, query: &TableQuery) -> String {
    let cols: Vec<String> = schema.columns.iter().map(|c| quote_ident(kind, &c.name)).collect();
    let col_list = if cols.is_empty() { "*".to_string() } else { cols.join(", ") };
    let mut sql = format!("SELECT {col_list} FROM {}", quote_table(kind, table));

    let mut preds: Vec<String> = Vec::new();
    for f in &query.filters {
        let col = schema.columns.iter().find(|c| c.name == f.column);
        let qcol = quote_ident(kind, &f.column);
        let is_text = col.map(|c| matches!(c.logical, LogicalType::Text)).unwrap_or(true);
        let like_col = if kind == DriverKind::Postgres && !is_text { format!("CAST({qcol} AS TEXT)") } else { qcol.clone() };
        let pred = match f.op {
            FilterOp::IsNull => format!("{qcol} IS NULL"),
            FilterOp::IsNotNull => format!("{qcol} IS NOT NULL"),
            FilterOp::In => {
                let Some(v) = &f.value else { continue };
                let items: Vec<String> = v
                    .split(',')
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(|s| filter_literal(kind, col, s))
                    .collect();
                if items.is_empty() {
                    "1 = 0".to_string()
                } else {
                    format!("{qcol} IN ({})", items.join(", "))
                }
            }
            FilterOp::Like | FilterOp::NotLike => {
                let Some(v) = &f.value else { continue };
                let op = if f.op == FilterOp::Like { "LIKE" } else { "NOT LIKE" };
                format!("{like_col} {op} {}", string_literal(kind, v))
            }
            FilterOp::Eq | FilterOp::Neq | FilterOp::Lt | FilterOp::Lte | FilterOp::Gt | FilterOp::Gte => {
                let Some(v) = &f.value else { continue };
                let op = match f.op {
                    FilterOp::Eq => "=",
                    FilterOp::Neq => "<>",
                    FilterOp::Lt => "<",
                    FilterOp::Lte => "<=",
                    FilterOp::Gt => ">",
                    _ => ">=",
                };
                format!("{qcol} {op} {}", filter_literal(kind, col, v))
            }
        };
        preds.push(pred);
    }
    if !preds.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&preds.join(" AND "));
    }

    if !query.sort.is_empty() {
        let parts: Vec<String> = query
            .sort
            .iter()
            .map(|s| format!("{} {}", quote_ident(kind, &s.column), if s.dir == SortDir::Desc { "DESC" } else { "ASC" }))
            .collect();
        sql.push_str(" ORDER BY ");
        sql.push_str(&parts.join(", "));
    }

    let limit = query.limit.unwrap_or(1000);
    sql.push_str(&format!(" LIMIT {limit}"));
    if let Some(off) = query.offset.filter(|o| *o > 0) {
        sql.push_str(&format!(" OFFSET {off}"));
    }
    sql
}

/// Render a cell as a literal for `col`. Postgres literals carry an explicit
/// `::type` cast so the server parses the exact string.
pub fn cell_literal(kind: DriverKind, col: Option<&ColumnInfo>, cell: &Cell) -> String {
    let logical = col.map(|c| c.logical).unwrap_or(LogicalType::Unknown);
    let pg_cast = |lit: String| match (kind, col) {
        (DriverKind::Postgres, Some(c)) => format!("{lit}::{}", c.data_type),
        _ => lit,
    };
    match cell {
        Cell::Null => "NULL".to_string(),
        Cell::Bool(b) => pg_cast(bool_literal(kind, *b)),
        Cell::Number(n) => pg_cast(n.to_string()),
        Cell::String(s) => {
            if logical == LogicalType::Bytes {
                if let Some(lit) = bytes_literal(kind, s) {
                    return lit;
                }
            }
            pg_cast(string_literal(kind, s))
        }
        Cell::Array(items) if kind == DriverKind::Postgres && logical == LogicalType::Array => {
            let elems: Vec<String> = items.iter().map(|v| cell_literal(DriverKind::Postgres, None, v)).collect();
            let ty = col.map(|c| c.data_type.as_str()).unwrap_or("text[]");
            format!("ARRAY[{}]::{ty}", elems.join(", "))
        }
        Cell::Array(_) | Cell::Object(_) => {
            let text = cell.to_string();
            let lit = string_literal(kind, &text);
            match kind {
                DriverKind::Postgres => {
                    let ty = match col {
                        Some(c) if c.logical == LogicalType::Json => c.data_type.as_str(),
                        _ => "jsonb",
                    };
                    format!("{lit}::{ty}")
                }
                _ => lit,
            }
        }
    }
}

fn pk_predicate(kind: DriverKind, schema: &TableSchema, pk: &std::collections::BTreeMap<String, Cell>) -> Result<String, IpcError> {
    let mut parts = Vec::with_capacity(schema.primary_key.len());
    for name in &schema.primary_key {
        let Some(v) = pk.get(name) else {
            return Err(IpcError::invalid(format!("change is missing primary key column '{name}'")));
        };
        let col = schema.columns.iter().find(|c| &c.name == name);
        let q = quote_ident(kind, name);
        parts.push(match v {
            Cell::Null => format!("{q} IS NULL"),
            _ => format!("{q} = {}", cell_literal(kind, col, v)),
        });
    }
    Ok(parts.join(" AND "))
}

/// Render a change set as `UPDATE` / `INSERT` / `DELETE` statements.
pub fn render_changes(kind: DriverKind, schema: &TableSchema, changes: &ChangeSet) -> Result<Vec<String>, IpcError> {
    let table = changes.table.as_ref().unwrap_or(&schema.table);
    let qtable = quote_table(kind, table);
    let needs_pk = !changes.updates.is_empty() || !changes.deletes.is_empty();
    if needs_pk && schema.primary_key.is_empty() {
        return Err(IpcError::invalid(format!(
            "table {} has no primary key; rows cannot be updated or deleted safely",
            table.name
        )));
    }
    let find_col = |name: &str| -> Result<&ColumnInfo, IpcError> {
        schema
            .columns
            .iter()
            .find(|c| c.name == name)
            .ok_or_else(|| IpcError::invalid(format!("unknown column '{name}' on table {}", table.name)))
    };

    let mut out = Vec::with_capacity(changes.updates.len() + changes.inserts.len() + changes.deletes.len());
    for u in &changes.updates {
        let col = find_col(&u.column)?;
        out.push(format!(
            "UPDATE {qtable} SET {} = {} WHERE {}",
            quote_ident(kind, &u.column),
            cell_literal(kind, Some(col), &u.value),
            pk_predicate(kind, schema, &u.pk)?
        ));
    }
    for ins in &changes.inserts {
        if ins.values.is_empty() {
            continue;
        }
        let mut names = Vec::with_capacity(ins.values.len());
        let mut vals = Vec::with_capacity(ins.values.len());
        for (name, v) in &ins.values {
            let col = find_col(name)?;
            names.push(quote_ident(kind, name));
            vals.push(cell_literal(kind, Some(col), v));
        }
        out.push(format!("INSERT INTO {qtable} ({}) VALUES ({})", names.join(", "), vals.join(", ")));
    }
    for d in &changes.deletes {
        out.push(format!("DELETE FROM {qtable} WHERE {}", pk_predicate(kind, schema, &d.pk)?));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numeric_literal_detection() {
        for ok in ["1", "-1", "+3", "3.5", ".5", "5.", "1e9", "1.5E-3", " 42 "] {
            assert!(is_numeric_literal(ok), "{ok}");
        }
        for bad in ["", "abc", "1,000", "1e", "--1", "0x10", "1.2.3", "NaN"] {
            assert!(!is_numeric_literal(bad), "{bad}");
        }
    }

    #[test]
    fn string_escaping_per_dialect() {
        assert_eq!(string_literal(DriverKind::Postgres, "it's \\ ok"), "'it''s \\ ok'");
        assert_eq!(string_literal(DriverKind::Sqlite, "it's \\ ok"), "'it''s \\ ok'");
        assert_eq!(string_literal(DriverKind::Mysql, "it's \\ ok"), "'it''s \\\\ ok'");
    }

    #[test]
    fn quoting() {
        assert_eq!(quote_ident(DriverKind::Postgres, "we\"ird"), "\"we\"\"ird\"");
        assert_eq!(quote_ident(DriverKind::Mysql, "we`ird"), "`we``ird`");
    }
}
