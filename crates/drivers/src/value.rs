//! Decoding `sqlx` rows into wire cells (`serde_json::Value`) by the rules in
//! `plinth_core::ipc`:
//!
//! - SQL NULL → JSON `null`; booleans → JSON bool; floats → JSON number
//!   (non-finite values → the strings `"NaN"`, `"Infinity"`, `"-Infinity"`);
//! - every integer, decimal, timestamp, uuid, byte string → JSON **string**;
//! - json/jsonb and arrays → real JSON values.
//!
//! Each driver has its own entry point because the value-ref types differ,
//! but the formatting helpers are shared.

use base64::Engine as _;
use chrono::{DateTime, FixedOffset, NaiveDate, NaiveDateTime, NaiveTime, SecondsFormat};
use plinth_core::*;
use sqlx::{Column, ColumnOrigin, Decode, Row, TypeInfo, ValueRef};

// ───────────────────────── shared formatting ─────────────────────────

pub fn float_cell(v: f64) -> Cell {
    if v.is_nan() {
        return Cell::String("NaN".into());
    }
    if v.is_infinite() {
        return Cell::String(if v > 0.0 { "Infinity" } else { "-Infinity" }.into());
    }
    // `from_f64` renders the shortest round-trip text (`0.1`, `1e300`).
    match serde_json::Number::from_f64(v) {
        Some(n) => Cell::Number(n),
        None => number_from_text(&v.to_string()),
    }
}

/// `f32` goes through its own shortest-round-trip text so `0.1f32` stays `0.1`.
pub fn float32_cell(v: f32) -> Cell {
    if v.is_nan() || v.is_infinite() {
        return float_cell(v as f64);
    }
    number_from_text(&v.to_string())
}

/// Build a JSON number from its decimal text. With serde_json's
/// `arbitrary_precision` feature the text is preserved verbatim.
fn number_from_text(text: &str) -> Cell {
    match serde_json::from_str::<serde_json::Number>(text) {
        Ok(n) => Cell::Number(n),
        Err(_) => Cell::String(text.to_string()),
    }
}

pub fn bytes_cell(b: &[u8]) -> Cell {
    Cell::String(base64::engine::general_purpose::STANDARD.encode(b))
}

pub fn timestamp_cell(ts: NaiveDateTime) -> Cell {
    Cell::String(ts.format("%Y-%m-%dT%H:%M:%S%.f").to_string())
}

pub fn timestamptz_cell(ts: DateTime<FixedOffset>) -> Cell {
    Cell::String(ts.to_rfc3339_opts(SecondsFormat::AutoSi, false))
}

pub fn date_cell(d: NaiveDate) -> Cell {
    Cell::String(d.format("%Y-%m-%d").to_string())
}

pub fn time_cell(t: NaiveTime) -> Cell {
    Cell::String(t.format("%H:%M:%S%.f").to_string())
}

fn unsupported(type_name: &str) -> Cell {
    Cell::String(format!("<{type_name}>"))
}

/// pgvector's binary layouts, decoded to its own text form `[0.1,0.2,0.3]`.
///
/// `vector`   : u16 dim, u16 unused, dim × f32 big-endian
/// `halfvec`  : u16 dim, u16 unused, dim × binary16 big-endian
/// `sparsevec`: i32 dim, i32 nnz, i32 unused, nnz × i32 index, nnz × f32
fn decode_pgvector(bytes: &[u8], type_name: &str) -> Option<String> {
    let u16_at = |i: usize| -> Option<u16> { Some(u16::from_be_bytes([*bytes.get(i)?, *bytes.get(i + 1)?])) };
    let u32_at = |i: usize| -> Option<u32> { Some(u32::from_be_bytes([*bytes.get(i)?, *bytes.get(i + 1)?, *bytes.get(i + 2)?, *bytes.get(i + 3)?])) };

    match type_name.to_ascii_lowercase().as_str() {
        "vector" => {
            let dim = u16_at(0)? as usize;
            let mut out = String::with_capacity(dim * 8 + 2);
            out.push('[');
            for i in 0..dim {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&f32::from_bits(u32_at(4 + i * 4)?).to_string());
            }
            out.push(']');
            Some(out)
        }
        "halfvec" => {
            let dim = u16_at(0)? as usize;
            let mut out = String::with_capacity(dim * 6 + 2);
            out.push('[');
            for i in 0..dim {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&half_to_f32(u16_at(4 + i * 2)?).to_string());
            }
            out.push(']');
            Some(out)
        }
        "sparsevec" => {
            let dim = u32_at(0)?;
            let nnz = u32_at(4)? as usize;
            // Sparse vectors are printed as pgvector prints them: {i:v,…}/dim.
            let mut out = String::from("{");
            for i in 0..nnz {
                if i > 0 {
                    out.push(',');
                }
                let index = u32_at(12 + i * 4)?;
                let v = f32::from_bits(u32_at(12 + nnz * 4 + i * 4)?);
                out.push_str(&format!("{}:{v}", index + 1));
            }
            out.push_str(&format!("}}/{dim}"));
            Some(out)
        }
        _ => None,
    }
}

/// IEEE-754 binary16 → f32. Ten lines beats a dependency for one type.
///
/// A subnormal half is `mantissa × 2⁻²⁴` by definition — computing that
/// directly is both shorter and harder to get wrong than re-normalising the
/// mantissa by hand into f32's exponent field.
fn half_to_f32(bits: u16) -> f32 {
    let sign_bit = ((bits as u32) & 0x8000) << 16;
    let exponent = ((bits >> 10) & 0x1f) as u32;
    let mantissa = (bits & 0x3ff) as u32;
    match exponent {
        0 => {
            let magnitude = mantissa as f32 * 2f32.powi(-24);
            if sign_bit != 0 {
                -magnitude
            } else {
                magnitude
            }
        }
        0x1f => f32::from_bits(sign_bit | (0xff << 23) | (mantissa << 13)),
        // Re-bias: half's exponent bias is 15, f32's is 127.
        _ => f32::from_bits(sign_bit | ((exponent + 112) << 23) | (mantissa << 13)),
    }
}

/// Bytes that are valid, printable UTF-8 → the string. Used as the fallback
/// for unknown types before giving up with `<type>`.
fn printable_text(bytes: &[u8]) -> Option<String> {
    let s = std::str::from_utf8(bytes).ok()?;
    if s.chars().any(|c| c.is_control() && !matches!(c, '\t' | '\n' | '\r')) {
        return None;
    }
    Some(s.to_string())
}

// ───────────────────────── column descriptors ─────────────────────────

fn table_ref_from_origin(origin: &ColumnOrigin) -> Option<TableRef> {
    let tc = origin.table_column()?;
    let full: &str = &tc.table;
    Some(match full.split_once('.') {
        Some((schema, name)) => TableRef { schema: Some(schema.to_string()), name: name.to_string() },
        None => TableRef { schema: None, name: full.to_string() },
    })
}

/// The raw type name as shown to the UI and the name used for logical mapping.
/// MySQL appends ` UNSIGNED`, which `logical_type_for` does not know about.
pub fn logical_from_raw(kind: DriverKind, raw: &str) -> LogicalType {
    let for_mapping = match kind {
        DriverKind::Mysql => raw.to_ascii_lowercase().replace(" unsigned", "").replace(" zerofill", ""),
        _ => raw.to_string(),
    };
    logical_type_for(kind, &for_mapping)
}

pub fn column_desc(kind: DriverKind, name: &str, raw_type: &str, origin: &ColumnOrigin) -> ColumnDesc {
    let data_type = match kind {
        DriverKind::Sqlite => raw_type.to_ascii_uppercase(),
        _ => raw_type.to_ascii_lowercase(),
    };
    let logical = logical_from_raw(kind, &data_type);
    ColumnDesc { name: name.to_string(), data_type, logical, wire: logical.wire(), nullable: None, table: table_ref_from_origin(origin) }
}

/// Column descriptors for a prepared statement's result columns.
pub fn columns_from_statement<C: Column>(kind: DriverKind, cols: &[C]) -> Vec<ColumnDesc> {
    cols.iter().map(|c| column_desc(kind, c.name(), c.type_info().name(), &c.origin())).collect()
}

/// `(table, original column name)` for each result column that comes
/// straight from a table.
pub fn origins_from_statement<C: Column>(cols: &[C]) -> Vec<Option<(String, String)>> {
    cols.iter()
        .map(|c| c.origin().table_column().map(|tc| (tc.table.to_string(), tc.name.to_string())))
        .collect()
}

// ───────────────────────── SQLite ─────────────────────────

/// SQLite has storage classes, not column types: the same column can hold an
/// integer in one row and text in the next. Rows are first decoded to their
/// storage class, then coerced to the column's wire kind once the column's
/// logical type is settled (declared type, else the first non-null value).
#[derive(Debug, Clone)]
pub enum SqliteRaw {
    Null,
    Int(i64),
    Real(f64),
    Text(String),
    Blob(Vec<u8>),
}

pub fn decode_sqlite_raw(row: &sqlx::sqlite::SqliteRow, idx: usize) -> SqliteRaw {
    let Ok(value) = row.try_get_raw(idx) else { return SqliteRaw::Null };
    if value.is_null() {
        return SqliteRaw::Null;
    }
    let storage = value.type_info().name().to_ascii_uppercase();
    match storage.as_str() {
        "INTEGER" => <i64 as Decode<sqlx::Sqlite>>::decode(value).map(SqliteRaw::Int).unwrap_or(SqliteRaw::Null),
        "REAL" => <f64 as Decode<sqlx::Sqlite>>::decode(value).map(SqliteRaw::Real).unwrap_or(SqliteRaw::Null),
        "BLOB" => <Vec<u8> as Decode<sqlx::Sqlite>>::decode(value).map(SqliteRaw::Blob).unwrap_or(SqliteRaw::Null),
        _ => {
            // TEXT that is not valid UTF-8 falls back to a blob.
            let owned = value.try_to_owned().ok();
            match <String as Decode<sqlx::Sqlite>>::decode(value) {
                Ok(s) => SqliteRaw::Text(s),
                Err(_) => owned
                    .and_then(|o| <Vec<u8> as Decode<sqlx::Sqlite>>::decode(sqlx::Value::as_ref(&o)).ok())
                    .map(SqliteRaw::Blob)
                    .unwrap_or(SqliteRaw::Null),
            }
        }
    }
}

impl SqliteRaw {
    fn storage_type(&self) -> Option<&'static str> {
        match self {
            SqliteRaw::Null => None,
            SqliteRaw::Int(_) => Some("INTEGER"),
            SqliteRaw::Real(_) => Some("REAL"),
            SqliteRaw::Text(_) => Some("TEXT"),
            SqliteRaw::Blob(_) => Some("BLOB"),
        }
    }

    /// Encode for the wire given the column's logical type.
    pub fn into_cell(self, logical: LogicalType) -> Cell {
        match self {
            SqliteRaw::Null => Cell::Null,
            SqliteRaw::Int(i) => match logical {
                LogicalType::Bool => Cell::Bool(i != 0),
                LogicalType::Float => float_cell(i as f64),
                _ => Cell::String(i.to_string()),
            },
            SqliteRaw::Real(f) => match logical {
                LogicalType::Float => float_cell(f),
                LogicalType::Bool => Cell::Bool(f != 0.0),
                _ => match float_cell(f) {
                    Cell::Number(n) => Cell::String(n.to_string()),
                    other => other,
                },
            },
            SqliteRaw::Text(s) => match logical {
                LogicalType::Json | LogicalType::Array | LogicalType::Document => {
                    serde_json::from_str::<serde_json::Value>(&s).unwrap_or(Cell::String(s))
                }
                LogicalType::Bool => match s.trim().to_ascii_lowercase().as_str() {
                    "1" | "true" | "t" => Cell::Bool(true),
                    "0" | "false" | "f" => Cell::Bool(false),
                    _ => Cell::String(s),
                },
                LogicalType::Float => match s.trim().parse::<f64>() {
                    Ok(f) => float_cell(f),
                    Err(_) => Cell::String(s),
                },
                _ => Cell::String(s),
            },
            SqliteRaw::Blob(b) => bytes_cell(&b),
        }
    }
}

/// Settle SQLite column descriptors and encode the raw rows. Columns whose
/// declared type is unknown (`NULL`, expressions) take the storage class of
/// the first non-null value.
pub fn finalize_sqlite(mut columns: Vec<ColumnDesc>, raw_rows: Vec<Vec<SqliteRaw>>) -> (Vec<ColumnDesc>, Vec<Vec<Cell>>) {
    for (i, col) in columns.iter_mut().enumerate() {
        if col.logical != LogicalType::Unknown {
            continue;
        }
        if let Some(storage) = raw_rows.iter().find_map(|r| r.get(i).and_then(SqliteRaw::storage_type)) {
            col.data_type = storage.to_string();
            col.logical = logical_type_for(DriverKind::Sqlite, storage);
            col.wire = col.logical.wire();
        }
    }
    let rows = raw_rows
        .into_iter()
        .map(|r| {
            r.into_iter()
                .enumerate()
                .map(|(i, raw)| raw.into_cell(columns.get(i).map(|c| c.logical).unwrap_or(LogicalType::Unknown)))
                .collect()
        })
        .collect();
    (columns, rows)
}

// ───────────────────────── Postgres ─────────────────────────

pub fn decode_pg(row: &sqlx::postgres::PgRow, idx: usize) -> Cell {
    let value = match row.try_get_raw(idx) {
        Ok(v) => v,
        Err(e) => return Cell::String(format!("<decode error: {e}>")),
    };
    if value.is_null() {
        return Cell::Null;
    }
    let ti = value.type_info().into_owned();
    pg_value(value, &ti)
}

fn pg_decode<'r, T: Decode<'r, sqlx::Postgres>>(value: sqlx::postgres::PgValueRef<'r>) -> Option<T> {
    T::decode(value).ok()
}

fn pg_value(value: sqlx::postgres::PgValueRef<'_>, ti: &sqlx::postgres::PgTypeInfo) -> Cell {
    use sqlx::postgres::types::{Oid, PgInterval, PgMoney, PgTimeTz};
    use sqlx::postgres::PgTypeKind;

    let name = ti.name().to_string();
    match ti.kind() {
        PgTypeKind::Enum(_) => return pg_decode::<String>(value).map(Cell::String).unwrap_or_else(|| unsupported(&name)),
        PgTypeKind::Domain(inner) => {
            let inner = inner.clone();
            return pg_value(value, &inner);
        }
        PgTypeKind::Array(elem) => {
            let elem = elem.clone();
            return pg_array(value, &elem, &name);
        }
        PgTypeKind::Composite(_) | PgTypeKind::Range(_) | PgTypeKind::Pseudo => return pg_text_fallback(value, &name),
        PgTypeKind::Simple => {}
    }

    match name.to_ascii_uppercase().as_str() {
        "BOOL" => pg_decode::<bool>(value).map(Cell::Bool),
        "\"CHAR\"" => pg_decode::<i8>(value).map(|c| Cell::String(((c as u8) as char).to_string())),
        "INT2" | "INT4" | "INT8" => pg_decode::<i64>(value).map(|i| Cell::String(i.to_string())),
        "OID" => pg_decode::<Oid>(value).map(|o| Cell::String(o.0.to_string())),
        "FLOAT4" => pg_decode::<f32>(value).map(float32_cell),
        "FLOAT8" => pg_decode::<f64>(value).map(float_cell),
        "NUMERIC" => Some(pg_numeric(value)),
        "MONEY" => pg_decode::<PgMoney>(value).map(|m| {
            let cents = m.0;
            let sign = if cents < 0 { "-" } else { "" };
            let abs = cents.unsigned_abs();
            Cell::String(format!("{sign}{}.{:02}", abs / 100, abs % 100))
        }),
        "TEXT" | "VARCHAR" | "CHAR" | "NAME" | "UNKNOWN" | "CITEXT" | "XML" => pg_decode::<String>(value).map(Cell::String),
        "BYTEA" => pg_decode::<Vec<u8>>(value).map(|b| bytes_cell(&b)),
        "JSON" | "JSONB" => pg_decode::<sqlx::types::Json<serde_json::Value>>(value).map(|j| j.0),
        "UUID" => pg_decode::<uuid::Uuid>(value).map(|u| Cell::String(u.hyphenated().to_string())),
        "TIMESTAMP" => pg_special_timestamp(&value).or_else(|| pg_decode::<NaiveDateTime>(value).map(timestamp_cell)),
        "TIMESTAMPTZ" => pg_special_timestamp(&value).or_else(|| pg_decode::<DateTime<FixedOffset>>(value).map(timestamptz_cell)),
        "DATE" => pg_special_date(&value).or_else(|| pg_decode::<NaiveDate>(value).map(date_cell)),
        "TIME" => pg_decode::<NaiveTime>(value).map(time_cell),
        "TIMETZ" => pg_decode::<PgTimeTz<NaiveTime, FixedOffset>>(value).map(|t| {
            let secs = t.offset.local_minus_utc();
            let sign = if secs < 0 { '-' } else { '+' };
            let a = secs.unsigned_abs();
            Cell::String(format!("{}{sign}{:02}:{:02}", t.time.format("%H:%M:%S%.f"), a / 3600, (a % 3600) / 60))
        }),
        // pgvector's text form is `[0.1,-0.2,…]`; sqlx has no type for it, and
        // we want the raw string anyway — the UI summarises it rather than
        // printing 1,536 numbers into a cell.
        // pgvector arrives in binary; sqlx has no type for it. Decode to the
        // same text form pgvector itself prints, so the UI can parse one thing.
        "VECTOR" | "HALFVEC" | "SPARSEVEC" => value
            .as_bytes()
            .ok()
            .and_then(|b| decode_pgvector(b, &name).or_else(|| printable_text(b)))
            .map(Cell::String),
        "INTERVAL" => pg_decode::<PgInterval>(value).map(|i| Cell::String(format_interval(&i))),
        "INET" | "CIDR" => value.as_bytes().ok().and_then(|b| decode_inet(b, name.eq_ignore_ascii_case("cidr"))).map(Cell::String),
        "MACADDR" | "MACADDR8" => value
            .as_bytes()
            .ok()
            .map(|b| Cell::String(b.iter().map(|x| format!("{x:02x}")).collect::<Vec<_>>().join(":"))),
        "BIT" | "VARBIT" => value.as_bytes().ok().and_then(decode_bits).map(Cell::String),
        _ => Some(pg_text_fallback(value, &name)),
    }
    .unwrap_or_else(|| unsupported(&name))
}

fn pg_text_fallback(value: sqlx::postgres::PgValueRef<'_>, name: &str) -> Cell {
    match value.as_bytes().ok().and_then(printable_text) {
        Some(s) => Cell::String(s),
        None => unsupported(name),
    }
}

/// Binary `numeric` header: ndigits, weight, sign, dscale (all 16-bit). The
/// sign field carries NaN / ±Infinity, which `BigDecimal` cannot represent.
fn pg_numeric(value: sqlx::postgres::PgValueRef<'_>) -> Cell {
    if value.format() == sqlx::postgres::PgValueFormat::Binary {
        if let Ok(bytes) = value.as_bytes() {
            if bytes.len() >= 6 {
                match u16::from_be_bytes([bytes[4], bytes[5]]) {
                    0xC000 => return Cell::String("NaN".into()),
                    0xD000 => return Cell::String("Infinity".into()),
                    0xF000 => return Cell::String("-Infinity".into()),
                    _ => {}
                }
            }
        }
    } else if let Ok(s) = value.as_str() {
        return Cell::String(s.to_string());
    }
    match pg_decode::<bigdecimal::BigDecimal>(value) {
        Some(d) => Cell::String(d.to_plain_string()),
        None => unsupported("numeric"),
    }
}

fn pg_special_timestamp(value: &sqlx::postgres::PgValueRef<'_>) -> Option<Cell> {
    if value.format() != sqlx::postgres::PgValueFormat::Binary {
        let s = value.as_str().ok()?;
        return s.contains("infinity").then(|| Cell::String(s.to_string()));
    }
    let bytes = value.as_bytes().ok()?;
    let raw = i64::from_be_bytes(bytes.try_into().ok()?);
    match raw {
        i64::MAX => Some(Cell::String("infinity".into())),
        i64::MIN => Some(Cell::String("-infinity".into())),
        _ => None,
    }
}

fn pg_special_date(value: &sqlx::postgres::PgValueRef<'_>) -> Option<Cell> {
    if value.format() != sqlx::postgres::PgValueFormat::Binary {
        let s = value.as_str().ok()?;
        return s.contains("infinity").then(|| Cell::String(s.to_string()));
    }
    let bytes = value.as_bytes().ok()?;
    let raw = i32::from_be_bytes(bytes.try_into().ok()?);
    match raw {
        i32::MAX => Some(Cell::String("infinity".into())),
        i32::MIN => Some(Cell::String("-infinity".into())),
        _ => None,
    }
}

fn format_interval(i: &sqlx::postgres::types::PgInterval) -> String {
    let mut parts = Vec::new();
    let years = i.months / 12;
    let months = i.months % 12;
    if years != 0 {
        parts.push(format!("{years} year{}", if years.abs() == 1 { "" } else { "s" }));
    }
    if months != 0 {
        parts.push(format!("{months} mon{}", if months.abs() == 1 { "" } else { "s" }));
    }
    if i.days != 0 {
        parts.push(format!("{} day{}", i.days, if i.days.abs() == 1 { "" } else { "s" }));
    }
    if i.microseconds != 0 || parts.is_empty() {
        let neg = i.microseconds < 0;
        let us = i.microseconds.unsigned_abs();
        let h = us / 3_600_000_000;
        let m = (us / 60_000_000) % 60;
        let s = (us / 1_000_000) % 60;
        let frac = us % 1_000_000;
        let mut t = format!("{}{h:02}:{m:02}:{s:02}", if neg { "-" } else { "" });
        if frac != 0 {
            t.push_str(format!(".{frac:06}").trim_end_matches('0'));
        }
        parts.push(t);
    }
    parts.join(" ")
}

/// Binary `inet`/`cidr`: family, prefix bits, is_cidr, address length, address.
fn decode_inet(b: &[u8], is_cidr: bool) -> Option<String> {
    if b.len() < 4 {
        return None;
    }
    let (family, bits, len) = (b[0], b[1], b[3] as usize);
    let addr = b.get(4..4 + len)?;
    let (text, max_bits) = match (family, len) {
        (2, 4) => (std::net::Ipv4Addr::new(addr[0], addr[1], addr[2], addr[3]).to_string(), 32),
        (3, 16) => {
            let octets: [u8; 16] = addr.try_into().ok()?;
            (std::net::Ipv6Addr::from(octets).to_string(), 128)
        }
        _ => return None,
    };
    Some(if is_cidr || bits != max_bits { format!("{text}/{bits}") } else { text })
}

/// Binary `bit`/`varbit`: i32 bit length followed by packed bytes.
fn decode_bits(b: &[u8]) -> Option<String> {
    if b.len() < 4 {
        return None;
    }
    let nbits = i32::from_be_bytes([b[0], b[1], b[2], b[3]]).max(0) as usize;
    let mut out = String::with_capacity(nbits);
    for i in 0..nbits {
        let byte = *b.get(4 + i / 8)?;
        out.push(if byte & (0x80 >> (i % 8)) != 0 { '1' } else { '0' });
    }
    Some(out)
}

fn pg_array(value: sqlx::postgres::PgValueRef<'_>, elem: &sqlx::postgres::PgTypeInfo, name: &str) -> Cell {
    use sqlx::postgres::PgTypeKind;

    fn arr<'r, T, F>(value: sqlx::postgres::PgValueRef<'r>, f: F) -> Option<Cell>
    where
        T: for<'a> Decode<'a, sqlx::Postgres> + sqlx::Type<sqlx::Postgres>,
        F: Fn(T) -> Cell,
    {
        let items = <Vec<Option<T>> as Decode<'r, sqlx::Postgres>>::decode(value).ok()?;
        Some(Cell::Array(items.into_iter().map(|v| v.map(&f).unwrap_or(Cell::Null)).collect()))
    }

    let elem_name = elem.name().to_ascii_uppercase();
    let decoded = if matches!(elem.kind(), PgTypeKind::Enum(_)) {
        arr::<String, _>(value, Cell::String)
    } else {
        match elem_name.as_str() {
            "BOOL" => arr::<bool, _>(value, Cell::Bool),
            "INT2" | "INT4" | "INT8" => arr::<i64, _>(value, |i| Cell::String(i.to_string())),
            "FLOAT4" => arr::<f32, _>(value, float32_cell),
            "FLOAT8" => arr::<f64, _>(value, float_cell),
            "NUMERIC" => arr::<bigdecimal::BigDecimal, _>(value, |d| Cell::String(d.to_plain_string())),
            "TEXT" | "VARCHAR" | "CHAR" | "NAME" | "CITEXT" | "XML" => arr::<String, _>(value, Cell::String),
            "BYTEA" => arr::<Vec<u8>, _>(value, |b| bytes_cell(&b)),
            "JSON" | "JSONB" => arr::<sqlx::types::Json<serde_json::Value>, _>(value, |j| j.0),
            "UUID" => arr::<uuid::Uuid, _>(value, |u| Cell::String(u.hyphenated().to_string())),
            "TIMESTAMP" => arr::<NaiveDateTime, _>(value, timestamp_cell),
            "TIMESTAMPTZ" => arr::<DateTime<FixedOffset>, _>(value, timestamptz_cell),
            "DATE" => arr::<NaiveDate, _>(value, date_cell),
            "TIME" => arr::<NaiveTime, _>(value, time_cell),
            _ => None,
        }
    };
    decoded.unwrap_or_else(|| unsupported(name))
}

// ───────────────────────── MySQL ─────────────────────────

pub fn decode_mysql(row: &sqlx::mysql::MySqlRow, idx: usize) -> Cell {
    let value = match row.try_get_raw(idx) {
        Ok(v) => v,
        Err(e) => return Cell::String(format!("<decode error: {e}>")),
    };
    if value.is_null() {
        return Cell::Null;
    }
    let name = value.type_info().name().to_string();
    mysql_value(value, &name)
}

fn my_decode<'r, T: Decode<'r, sqlx::MySql>>(value: sqlx::mysql::MySqlValueRef<'r>) -> Option<T> {
    T::decode(value).ok()
}

fn mysql_value(value: sqlx::mysql::MySqlValueRef<'_>, name: &str) -> Cell {
    use sqlx::mysql::types::MySqlTime;

    match name.to_ascii_uppercase().as_str() {
        "NULL" => Some(Cell::Null),
        "BOOLEAN" => my_decode::<i8>(value).map(|v| match v {
            0 => Cell::Bool(false),
            1 => Cell::Bool(true),
            other => Cell::String(other.to_string()),
        }),
        "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "BIGINT" => my_decode::<i64>(value).map(|i| Cell::String(i.to_string())),
        "TINYINT UNSIGNED" | "SMALLINT UNSIGNED" | "MEDIUMINT UNSIGNED" | "INT UNSIGNED" | "BIGINT UNSIGNED" | "YEAR" | "BIT" => {
            my_decode::<u64>(value).map(|i| Cell::String(i.to_string()))
        }
        "FLOAT" => my_decode::<f32>(value).map(float32_cell),
        "DOUBLE" => my_decode::<f64>(value).map(float_cell),
        // DECIMAL travels as text in both protocols; keep the exact digits.
        "DECIMAL" => my_decode::<String>(value).map(Cell::String),
        "DATETIME" => my_decode::<NaiveDateTime>(value).map(timestamp_cell),
        // The session time zone is pinned to +00:00 by the connect options.
        "TIMESTAMP" => my_decode::<NaiveDateTime>(value).map(|ts| Cell::String(format!("{}+00:00", ts.format("%Y-%m-%dT%H:%M:%S%.f")))),
        "DATE" => my_decode::<NaiveDate>(value).map(date_cell),
        "TIME" => my_decode::<MySqlTime>(value).map(|t| Cell::String(t.to_string())),
        "JSON" => my_decode::<sqlx::types::Json<serde_json::Value>>(value).map(|j| j.0),
        "BINARY" | "VARBINARY" | "TINYBLOB" | "BLOB" | "MEDIUMBLOB" | "LONGBLOB" | "GEOMETRY" => {
            my_decode::<Vec<u8>>(value).map(|b| bytes_cell(&b))
        }
        "CHAR" | "VARCHAR" | "TINYTEXT" | "TEXT" | "MEDIUMTEXT" | "LONGTEXT" | "ENUM" | "SET" => my_decode::<String>(value).map(Cell::String),
        _ => my_decode::<Vec<u8>>(value).and_then(|b| printable_text(&b)).map(Cell::String),
    }
    .unwrap_or_else(|| unsupported(name))
}

#[cfg(test)]
mod tests {
    #[test]
    fn pgvector_binary_decodes_to_its_own_text_form() {
        // u16 dim, u16 unused, then big-endian f32s — 0.1, 0.2, 0.3.
        let bytes = [0, 3, 0, 0, 61, 204, 204, 205, 62, 76, 204, 205, 62, 153, 153, 154];
        assert_eq!(decode_pgvector(&bytes, "vector").as_deref(), Some("[0.1,0.2,0.3]"));
    }

    #[test]
    fn half_precision_covers_the_awkward_cases() {
        assert_eq!(half_to_f32(0x0000), 0.0);
        assert_eq!(half_to_f32(0x8000), -0.0);
        assert_eq!(half_to_f32(0x3c00), 1.0);
        assert_eq!(half_to_f32(0xc000), -2.0);
        assert!((half_to_f32(0x3555) - 0.333).abs() < 0.001);
        // Smallest subnormal: the branch that normalises by hand.
        assert!((half_to_f32(0x0001) - 5.96e-8).abs() < 1e-9);
        assert!(half_to_f32(0x7c00).is_infinite());
        assert!(half_to_f32(0x7e00).is_nan());
    }

    use super::*;

    #[test]
    fn floats_follow_wire_rules() {
        assert_eq!(float_cell(0.1), serde_json::json!(0.1));
        assert_eq!(float_cell(f64::NAN), Cell::String("NaN".into()));
        assert_eq!(float_cell(f64::INFINITY), Cell::String("Infinity".into()));
        assert_eq!(float_cell(f64::NEG_INFINITY), Cell::String("-Infinity".into()));
        assert_eq!(float32_cell(0.1f32).to_string(), "0.1");
    }

    #[test]
    fn temporal_formats() {
        let ts = NaiveDate::from_ymd_opt(2024, 3, 9).and_then(|d| d.and_hms_micro_opt(1, 2, 3, 450_000));
        assert_eq!(timestamp_cell(ts.expect("valid")), Cell::String("2024-03-09T01:02:03.450".into()));
        let ts0 = NaiveDate::from_ymd_opt(2024, 3, 9).and_then(|d| d.and_hms_opt(1, 2, 3));
        assert_eq!(timestamp_cell(ts0.expect("valid")), Cell::String("2024-03-09T01:02:03".into()));
        let tz = DateTime::parse_from_rfc3339("2024-03-09T01:02:03.000001+00:00").expect("valid");
        assert_eq!(timestamptz_cell(tz), Cell::String("2024-03-09T01:02:03.000001+00:00".into()));
    }

    #[test]
    fn inet_and_bits() {
        assert_eq!(decode_inet(&[2, 32, 0, 4, 10, 0, 0, 1], false).as_deref(), Some("10.0.0.1"));
        assert_eq!(decode_inet(&[2, 24, 1, 4, 10, 0, 0, 0], true).as_deref(), Some("10.0.0.0/24"));
        assert_eq!(decode_bits(&[0, 0, 0, 3, 0b1010_0000]).as_deref(), Some("101"));
    }

    #[test]
    fn interval_text() {
        let i = sqlx::postgres::types::PgInterval { months: 14, days: 3, microseconds: 3_723_000_500 };
        assert_eq!(format_interval(&i), "1 year 2 mons 3 days 01:02:03.0005");
    }

    #[test]
    fn sqlite_coercion() {
        assert_eq!(SqliteRaw::Int(5).into_cell(LogicalType::Int), Cell::String("5".into()));
        assert_eq!(SqliteRaw::Int(1).into_cell(LogicalType::Bool), Cell::Bool(true));
        assert_eq!(SqliteRaw::Real(0.1).into_cell(LogicalType::Decimal), Cell::String("0.1".into()));
        assert_eq!(SqliteRaw::Real(0.1).into_cell(LogicalType::Float), serde_json::json!(0.1));
        assert_eq!(SqliteRaw::Text("{\"a\":1}".into()).into_cell(LogicalType::Json), serde_json::json!({"a": 1}));
        assert_eq!(SqliteRaw::Blob(vec![0, 255]).into_cell(LogicalType::Bytes), Cell::String("AP8=".into()));
    }
}
