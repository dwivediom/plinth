//! Local metadata store: connection profiles (never secrets), the console
//! log / history, saved queries and a small key/value bag for UI state.
//! One SQLite file at `<data_dir>/plinth.db`.

use crate::ipc::*;
use chrono::{SecondsFormat, Utc};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::{Row, SqlitePool};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

/// Newest rows kept in the `console` table.
pub const CONSOLE_CAP: i64 = 20_000;
/// How many appends between cap enforcement passes.
const TRIM_EVERY: u64 = 256;

pub fn now_rfc3339() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// What the engine records for one executed statement.
#[derive(Debug, Clone)]
pub struct NewConsoleEntry {
    pub workspace_id: Option<WorkspaceId>,
    pub connection_id: ConnectionId,
    pub source: ConsoleSource,
    pub sql: String,
    pub duration_ms: u64,
    pub rows: Option<u64>,
    pub error: Option<String>,
}

pub struct Store {
    pool: SqlitePool,
    appends: AtomicU64,
}

fn source_str(s: ConsoleSource) -> &'static str {
    match s {
        ConsoleSource::App => "app",
        ConsoleSource::User => "user",
        ConsoleSource::Ai => "ai",
    }
}

fn source_parse(s: &str) -> ConsoleSource {
    match s {
        "app" => ConsoleSource::App,
        "ai" => ConsoleSource::Ai,
        _ => ConsoleSource::User,
    }
}

const MIGRATIONS: &[&str] = &[
    "CREATE TABLE IF NOT EXISTS connections (
        id TEXT PRIMARY KEY,
        profile TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )",
    "CREATE TABLE IF NOT EXISTS console (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT,
        connection_id TEXT NOT NULL,
        source TEXT NOT NULL,
        sql TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        rows INTEGER,
        error TEXT,
        at TEXT NOT NULL
    )",
    "CREATE INDEX IF NOT EXISTS console_workspace ON console (workspace_id, id)",
    "CREATE INDEX IF NOT EXISTS console_connection ON console (connection_id, id)",
    "CREATE TABLE IF NOT EXISTS saved_queries (
        id TEXT PRIMARY KEY,
        connection_id TEXT,
        name TEXT NOT NULL,
        folder TEXT,
        sql TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )",
    "CREATE TABLE IF NOT EXISTS kv_state (
        key TEXT PRIMARY KEY,
        json TEXT NOT NULL
    )",
];

impl Store {
    /// Open (creating if needed) `<data_dir>/plinth.db` and run migrations.
    pub async fn open(data_dir: &Path) -> Result<Store, IpcError> {
        std::fs::create_dir_all(data_dir)?;
        let path = data_dir.join("plinth.db");
        let opts = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .busy_timeout(Duration::from_secs(5))
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(opts)
            .await?;
        let store = Store {
            pool,
            appends: AtomicU64::new(0),
        };
        store.migrate().await?;
        Ok(store)
    }

    async fn migrate(&self) -> Result<(), IpcError> {
        for m in MIGRATIONS {
            sqlx::query(*m).execute(&self.pool).await?;
        }
        Ok(())
    }

    // ───────────── connections ─────────────

    pub async fn connections_list(&self) -> Result<Vec<ConnectionProfile>, IpcError> {
        let rows = sqlx::query("SELECT profile FROM connections ORDER BY updated_at DESC")
            .fetch_all(&self.pool)
            .await?;
        let mut out: Vec<ConnectionProfile> = Vec::with_capacity(rows.len());
        for r in rows {
            let json: String = r.try_get("profile")?;
            out.push(serde_json::from_str(&json)?);
        }
        out.sort_by_key(|p| p.name.to_lowercase());
        Ok(out)
    }

    pub async fn connection_get(&self, id: &str) -> Result<Option<ConnectionProfile>, IpcError> {
        let row = sqlx::query("SELECT profile FROM connections WHERE id = ?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?;
        match row {
            Some(r) => {
                let json: String = r.try_get("profile")?;
                Ok(Some(serde_json::from_str(&json)?))
            }
            None => Ok(None),
        }
    }

    pub async fn connection_save(&self, profile: &ConnectionProfile) -> Result<(), IpcError> {
        let json = serde_json::to_string(profile)?;
        sqlx::query(
            "INSERT INTO connections (id, profile, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET profile = excluded.profile, updated_at = excluded.updated_at",
        )
        .bind(&profile.id)
        .bind(json)
        .bind(now_rfc3339())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn connection_delete(&self, id: &str) -> Result<bool, IpcError> {
        let r = sqlx::query("DELETE FROM connections WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(r.rows_affected() > 0)
    }

    // ───────────── console ─────────────

    pub async fn console_append(&self, e: NewConsoleEntry) -> Result<ConsoleEntry, IpcError> {
        let at = now_rfc3339();
        let r = sqlx::query(
            "INSERT INTO console (workspace_id, connection_id, source, sql, duration_ms, rows, error, at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&e.workspace_id)
        .bind(&e.connection_id)
        .bind(source_str(e.source))
        .bind(&e.sql)
        .bind(e.duration_ms as i64)
        .bind(e.rows.map(|r| r as i64))
        .bind(&e.error)
        .bind(&at)
        .execute(&self.pool)
        .await?;
        let id = r.last_insert_rowid();

        let n = self.appends.fetch_add(1, Ordering::Relaxed) + 1;
        if n.is_multiple_of(TRIM_EVERY) {
            self.console_trim(CONSOLE_CAP).await?;
        }

        Ok(ConsoleEntry {
            id,
            workspace_id: e.workspace_id,
            connection_id: e.connection_id,
            source: e.source,
            sql: e.sql,
            duration_ms: e.duration_ms,
            rows: e.rows,
            error: e.error,
            at,
        })
    }

    /// Delete everything but the newest `keep` console rows.
    pub async fn console_trim(&self, keep: i64) -> Result<u64, IpcError> {
        let r = sqlx::query(
            "DELETE FROM console WHERE id NOT IN (SELECT id FROM console ORDER BY id DESC LIMIT ?)",
        )
        .bind(keep)
        .execute(&self.pool)
        .await?;
        Ok(r.rows_affected())
    }

    /// Newest first. `workspace_id = None` returns entries from every workspace.
    pub async fn console_list(
        &self,
        workspace_id: Option<&str>,
        limit: u32,
    ) -> Result<Vec<ConsoleEntry>, IpcError> {
        let rows = match workspace_id {
            Some(ws) => {
                sqlx::query("SELECT * FROM console WHERE workspace_id = ? ORDER BY id DESC LIMIT ?")
                    .bind(ws)
                    .bind(limit as i64)
                    .fetch_all(&self.pool)
                    .await?
            }
            None => {
                sqlx::query("SELECT * FROM console ORDER BY id DESC LIMIT ?")
                    .bind(limit as i64)
                    .fetch_all(&self.pool)
                    .await?
            }
        };
        rows.iter().map(row_to_console).collect()
    }

    /// Statements a person or agent ran on a connection (`user` + `ai`
    /// sources), across all of its workspaces, newest first.
    pub async fn history_list(
        &self,
        connection_id: &str,
        limit: u32,
    ) -> Result<Vec<ConsoleEntry>, IpcError> {
        let rows = sqlx::query(
            "SELECT * FROM console WHERE connection_id = ? AND source != 'app' ORDER BY id DESC LIMIT ?",
        )
        .bind(connection_id)
        .bind(limit as i64)
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(row_to_console).collect()
    }

    // ───────────── saved queries ─────────────

    /// `connection_id = Some(c)` → queries for `c` plus shared ones (NULL
    /// connection). `None` → everything.
    pub async fn saved_list(
        &self,
        connection_id: Option<&str>,
    ) -> Result<Vec<SavedQuery>, IpcError> {
        let rows =
            match connection_id {
                Some(c) => sqlx::query(
                    "SELECT * FROM saved_queries WHERE connection_id = ? OR connection_id IS NULL
                     ORDER BY folder, name",
                )
                .bind(c)
                .fetch_all(&self.pool)
                .await?,
                None => {
                    sqlx::query("SELECT * FROM saved_queries ORDER BY folder, name")
                        .fetch_all(&self.pool)
                        .await?
                }
            };
        rows.iter().map(row_to_saved).collect()
    }

    pub async fn saved_save(&self, q: &SavedQuery) -> Result<(), IpcError> {
        sqlx::query(
            "INSERT INTO saved_queries (id, connection_id, name, folder, sql, updated_at) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET connection_id = excluded.connection_id, name = excluded.name,
             folder = excluded.folder, sql = excluded.sql, updated_at = excluded.updated_at",
        )
        .bind(&q.id)
        .bind(&q.connection_id)
        .bind(&q.name)
        .bind(&q.folder)
        .bind(&q.sql)
        .bind(&q.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn saved_delete(&self, id: &str) -> Result<bool, IpcError> {
        let r = sqlx::query("DELETE FROM saved_queries WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(r.rows_affected() > 0)
    }

    // ───────────── kv state ─────────────

    /// `Value::Null` when the key is absent.
    pub async fn state_get(&self, key: &str) -> Result<serde_json::Value, IpcError> {
        let row = sqlx::query("SELECT json FROM kv_state WHERE key = ?")
            .bind(key)
            .fetch_optional(&self.pool)
            .await?;
        match row {
            Some(r) => {
                let json: String = r.try_get("json")?;
                Ok(serde_json::from_str(&json)?)
            }
            None => Ok(serde_json::Value::Null),
        }
    }

    pub async fn state_set(&self, key: &str, value: &serde_json::Value) -> Result<(), IpcError> {
        if value.is_null() {
            sqlx::query("DELETE FROM kv_state WHERE key = ?")
                .bind(key)
                .execute(&self.pool)
                .await?;
            return Ok(());
        }
        let json = serde_json::to_string(value)?;
        sqlx::query(
            "INSERT INTO kv_state (key, json) VALUES (?, ?)
             ON CONFLICT(key) DO UPDATE SET json = excluded.json",
        )
        .bind(key)
        .bind(json)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn close(&self) {
        self.pool.close().await;
    }
}

fn row_to_console(r: &sqlx::sqlite::SqliteRow) -> Result<ConsoleEntry, IpcError> {
    let source: String = r.try_get("source")?;
    let duration_ms: i64 = r.try_get("duration_ms")?;
    let rows: Option<i64> = r.try_get("rows")?;
    Ok(ConsoleEntry {
        id: r.try_get("id")?,
        workspace_id: r.try_get("workspace_id")?,
        connection_id: r.try_get("connection_id")?,
        source: source_parse(&source),
        sql: r.try_get("sql")?,
        duration_ms: duration_ms.max(0) as u64,
        rows: rows.map(|n| n.max(0) as u64),
        error: r.try_get("error")?,
        at: r.try_get("at")?,
    })
}

fn row_to_saved(r: &sqlx::sqlite::SqliteRow) -> Result<SavedQuery, IpcError> {
    Ok(SavedQuery {
        id: r.try_get("id")?,
        connection_id: r.try_get("connection_id")?,
        name: r.try_get("name")?,
        folder: r.try_get("folder")?,
        sql: r.try_get("sql")?,
        updated_at: r.try_get("updated_at")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    pub(crate) fn temp_dir() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("plinth-test-{}", uuid::Uuid::new_v4()))
    }

    fn profile(id: &str, name: &str) -> ConnectionProfile {
        ConnectionProfile {
            id: id.into(),
            name: name.into(),
            driver: DriverKind::Postgres,
            environment: Environment::Staging,
            policy: PolicyMode::ReadOnly,
            color: None,
            host: Some("db.example".into()),
            port: Some(5432),
            database: Some("app".into()),
            user: Some("me".into()),
            file_path: None,
            ssl: SslMode::Require,
            has_password: true,
            last_used_at: None,
            favorite: true,
            folder: Some("work".into()),
            statement_timeout_ms: Some(30_000),
        }
    }

    #[tokio::test]
    async fn opens_creates_dir_and_reopens() {
        let dir = temp_dir().join("nested").join("deeper");
        let s = Store::open(&dir).await.expect("open");
        assert!(dir.join("plinth.db").exists());
        s.connection_save(&profile("a", "Alpha"))
            .await
            .expect("save");
        s.close().await;
        let s = Store::open(&dir).await.expect("reopen");
        assert_eq!(s.connections_list().await.expect("list").len(), 1);
    }

    #[tokio::test]
    async fn connections_round_trip() {
        let s = Store::open(&temp_dir()).await.expect("open");
        s.connection_save(&profile("b", "Beta"))
            .await
            .expect("save");
        s.connection_save(&profile("a", "alpha"))
            .await
            .expect("save");
        let list = s.connections_list().await.expect("list");
        assert_eq!(
            list.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
            vec!["a", "b"]
        );
        assert_eq!(list[1], profile("b", "Beta"));

        let mut p = profile("b", "Beta 2");
        p.favorite = false;
        s.connection_save(&p).await.expect("upsert");
        assert_eq!(
            s.connection_get("b").await.expect("get").map(|p| p.name),
            Some("Beta 2".into())
        );
        assert!(s.connection_delete("b").await.expect("delete"));
        assert!(!s.connection_delete("b").await.expect("delete again"));
        assert!(s.connection_get("b").await.expect("get").is_none());
    }

    #[tokio::test]
    async fn console_and_history() {
        let s = Store::open(&temp_dir()).await.expect("open");
        let mk = |ws: &str, src: ConsoleSource, sql: &str| NewConsoleEntry {
            workspace_id: Some(ws.into()),
            connection_id: "c1".into(),
            source: src,
            sql: sql.into(),
            duration_ms: 7,
            rows: Some(3),
            error: None,
        };
        let e1 = s
            .console_append(mk("w1", ConsoleSource::App, "select 1"))
            .await
            .expect("append");
        assert!(e1.id > 0);
        assert!(e1.at.contains('T'));
        chrono::DateTime::parse_from_rfc3339(&e1.at).expect("rfc3339");
        s.console_append(mk("w1", ConsoleSource::User, "select 2"))
            .await
            .expect("append");
        s.console_append(mk("w2", ConsoleSource::Ai, "select 3"))
            .await
            .expect("append");
        let mut err = mk("w2", ConsoleSource::User, "bad");
        err.error = Some("boom".into());
        err.rows = None;
        s.console_append(err).await.expect("append");

        let all = s.console_list(None, 10).await.expect("list");
        assert_eq!(all.len(), 4);
        assert_eq!(all[0].sql, "bad", "newest first");
        assert_eq!(all[0].error.as_deref(), Some("boom"));
        assert_eq!(all[0].rows, None);
        assert_eq!(all[3].source, ConsoleSource::App);

        let w1 = s.console_list(Some("w1"), 10).await.expect("list");
        assert_eq!(w1.len(), 2);
        assert_eq!(s.console_list(None, 1).await.expect("list").len(), 1);

        let h = s.history_list("c1", 10).await.expect("history");
        assert_eq!(h.len(), 3, "app entries are not history");
        assert!(h.iter().all(|e| e.source != ConsoleSource::App));
        assert!(s
            .history_list("nope", 10)
            .await
            .expect("history")
            .is_empty());
    }

    #[tokio::test]
    async fn console_cap_trims_oldest() {
        let s = Store::open(&temp_dir()).await.expect("open");
        for i in 0..30 {
            s.console_append(NewConsoleEntry {
                workspace_id: None,
                connection_id: "c".into(),
                source: ConsoleSource::User,
                sql: format!("select {i}"),
                duration_ms: 0,
                rows: None,
                error: None,
            })
            .await
            .expect("append");
        }
        let removed = s.console_trim(10).await.expect("trim");
        assert_eq!(removed, 20);
        let left = s.console_list(None, 100).await.expect("list");
        assert_eq!(left.len(), 10);
        assert_eq!(left[0].sql, "select 29");
        assert_eq!(left[9].sql, "select 20");
    }

    #[tokio::test]
    async fn saved_queries_round_trip() {
        let s = Store::open(&temp_dir()).await.expect("open");
        let q = |id: &str, conn: Option<&str>, name: &str| SavedQuery {
            id: id.into(),
            connection_id: conn.map(String::from),
            name: name.into(),
            folder: Some("reports".into()),
            sql: "select 1".into(),
            updated_at: now_rfc3339(),
        };
        s.saved_save(&q("1", Some("c1"), "one"))
            .await
            .expect("save");
        s.saved_save(&q("2", None, "shared")).await.expect("save");
        s.saved_save(&q("3", Some("c2"), "other"))
            .await
            .expect("save");

        let for_c1 = s.saved_list(Some("c1")).await.expect("list");
        assert_eq!(
            for_c1.iter().map(|q| q.id.as_str()).collect::<Vec<_>>(),
            vec!["1", "2"]
        );
        assert_eq!(s.saved_list(None).await.expect("list").len(), 3);

        let mut upd = q("1", Some("c1"), "renamed");
        upd.sql = "select 2".into();
        s.saved_save(&upd).await.expect("upsert");
        let for_c1 = s.saved_list(Some("c1")).await.expect("list");
        let one = for_c1.iter().find(|q| q.id == "1").expect("present");
        assert_eq!(one.name, "renamed");
        assert_eq!(one.sql, "select 2");
        assert_eq!(one.folder.as_deref(), Some("reports"));

        assert!(s.saved_delete("1").await.expect("delete"));
        assert!(!s.saved_delete("1").await.expect("delete"));
        assert_eq!(s.saved_list(Some("c1")).await.expect("list").len(), 1);
    }

    #[tokio::test]
    async fn kv_state_round_trip() {
        let s = Store::open(&temp_dir()).await.expect("open");
        assert_eq!(s.state_get("missing").await.expect("get"), json!(null));
        let v = json!({"tabs": [{"kind": "table", "title": "orders"}], "n": 3});
        s.state_set("layout", &v).await.expect("set");
        assert_eq!(s.state_get("layout").await.expect("get"), v);
        s.state_set("layout", &json!("x")).await.expect("overwrite");
        assert_eq!(s.state_get("layout").await.expect("get"), json!("x"));
        s.state_set("layout", &json!(null)).await.expect("clear");
        assert_eq!(s.state_get("layout").await.expect("get"), json!(null));
    }
}
