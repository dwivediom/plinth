//! Driver-agnostic statement execution: prepare (for column metadata), stream
//! rows with `fetch_many`, stop one past `limit` so `truncated` is exact, and
//! collect `rows_affected` for statements that produce no rows.

use crate::value::{columns_from_statement, origins_from_statement};
use futures::StreamExt;
use plinth_core::*;
use sqlx::{AssertSqlSafe, Database, Either, Executor, IntoArguments, SqlSafeStr, Statement};
use std::time::Duration;

pub(crate) struct Fetched<T> {
    pub columns: Vec<ColumnDesc>,
    /// `(table, column)` origin per result column, when the driver knows it.
    pub origins: Vec<Option<(String, String)>>,
    pub rows: Vec<T>,
    pub truncated: bool,
    pub rows_affected: Option<u64>,
}

pub(crate) const DEFAULT_LIMIT: u32 = 1000;

pub(crate) async fn fetch_limited<DB, T, F, A>(
    kind: DriverKind,
    conn: &mut DB::Connection,
    sql: &str,
    limit: usize,
    mut decode: F,
    rows_affected: A,
) -> Result<Fetched<T>, sqlx::Error>
where
    DB: Database,
    DB::Arguments: IntoArguments<DB>,
    for<'c> &'c mut DB::Connection: Executor<'c, Database = DB>,
    F: FnMut(&DB::Row) -> T + Send,
    A: Fn(&DB::QueryResult) -> u64 + Send,
    T: Send,
{
    let stmt = (&mut *conn).prepare(AssertSqlSafe(sql.to_owned()).into_sql_str()).await?;
    let columns = columns_from_statement(kind, stmt.columns());
    let origins = origins_from_statement(stmt.columns());
    let mut rows: Vec<T> = Vec::new();
    let mut truncated = false;
    let mut affected = 0u64;
    {
        let mut stream = (&mut *conn).fetch_many(stmt.query());
        while let Some(item) = stream.next().await {
            match item? {
                Either::Left(qr) => affected += rows_affected(&qr),
                Either::Right(row) => {
                    if rows.len() >= limit {
                        truncated = true;
                        break;
                    }
                    rows.push(decode(&row));
                }
            }
        }
    }
    let rows_affected = if columns.is_empty() { Some(affected) } else { None };
    Ok(Fetched { columns, origins, rows, truncated, rows_affected })
}

/// Apply `opts.timeout_ms` to a future; `None` means no timeout.
pub(crate) async fn with_timeout<T>(
    timeout_ms: Option<u64>,
    fut: impl std::future::Future<Output = Result<T, IpcError>>,
) -> Result<T, IpcError> {
    match timeout_ms {
        Some(ms) if ms > 0 => match tokio::time::timeout(Duration::from_millis(ms), fut).await {
            Ok(r) => r,
            Err(_) => Err(IpcError {
                code: "driver".into(),
                message: format!("statement timed out after {ms} ms"),
                detail: Some(TIMEOUT_DETAIL.into()),
            }),
        },
        _ => fut.await,
    }
}

pub(crate) const TIMEOUT_DETAIL: &str = "timeout";

pub(crate) fn is_timeout(e: &IpcError) -> bool {
    e.detail.as_deref() == Some(TIMEOUT_DETAIL)
}

/// Map an sqlx error to an `IpcError`, carrying the SQLSTATE / vendor code in
/// `detail` when the server reported one.
pub(crate) fn db_error(e: sqlx::Error) -> IpcError {
    match &e {
        sqlx::Error::Database(db) => IpcError {
            code: "driver".into(),
            message: db.message().to_string(),
            detail: db.code().map(|c| c.into_owned()),
        },
        _ => IpcError::driver(e),
    }
}

/// Run `statements` inside one transaction and sum rows affected. Any error
/// rolls back (the transaction is dropped without commit).
macro_rules! apply_in_transaction {
    ($pool:expr, $statements:expr) => {{
        let mut tx = $pool.begin().await?;
        let mut total: u64 = 0;
        for s in $statements {
            let r = sqlx::raw_sql(sqlx::AssertSqlSafe(s.clone())).execute(&mut *tx).await?;
            total += r.rows_affected();
        }
        tx.commit().await?;
        Ok(total)
    }};
}
pub(crate) use apply_in_transaction;
