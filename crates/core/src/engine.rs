//! `Engine`: one method per command in the IPC catalogue. Owns the metadata
//! store, secrets, open workspaces (each holding a `Driver`), buffered cursors
//! and the event channel. Front-ends (Tauri commands, the MCP server) are thin
//! wrappers around this type.

use crate::cursor::Cursors;
use crate::driver::{Driver, DriverFactory, QueryOpts};
use crate::ipc::*;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::policy;
use crate::secrets::{password_key, SecretStore};
use crate::store::{now_rfc3339, NewConsoleEntry, Store};
use dashmap::DashMap;
use parking_lot::RwLock;
use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::broadcast;

/// Rows buffered per statement when the caller gives no limit.
pub const DEFAULT_ROW_LIMIT: u32 = 1000;
/// Hard cap on one `cursor_fetch` window (PLAN.md §8a: IPC carries windows).
pub const MAX_FETCH_LEN: u32 = 10_000;

struct Workspace {
    info: WorkspaceInfo,
    driver: Arc<dyn Driver>,
    schema_cache: RwLock<Option<SchemaIndex>>,
    table_schemas: DashMap<TableRef, TableSchema>,
    /// The toolbar padlock, enforced here rather than in the UI. It starts on
    /// wherever a mistake would be expensive, so a workspace is never briefly
    /// writable between opening and the window telling us what it remembers.
    safe_mode: AtomicBool,
}

impl Workspace {
    fn invalidate_schema(&self) {
        *self.schema_cache.write() = None;
        self.table_schemas.clear();
    }

    fn safe_mode(&self) -> bool {
        self.safe_mode.load(Ordering::Relaxed)
    }

    /// Safe mode cannot widen a policy, only narrow it.
    fn read_only(&self) -> bool {
        self.safe_mode() || self.info.policy == PolicyMode::ReadOnly
    }
}

pub struct Engine {
    store: Store,
    secrets: Arc<dyn SecretStore>,
    factory: Arc<dyn DriverFactory>,
    workspaces: DashMap<WorkspaceId, Arc<Workspace>>,
    cursors: Cursors,
    events: broadcast::Sender<EngineEvent>,
}

impl Engine {
    pub async fn new(
        data_dir: PathBuf,
        secrets: Arc<dyn SecretStore>,
        factory: Arc<dyn DriverFactory>,
    ) -> Result<Arc<Engine>, IpcError> {
        let store = Store::open(&data_dir).await?;
        let (events, _) = broadcast::channel(512);
        Ok(Arc::new(Engine {
            store,
            secrets,
            factory,
            workspaces: DashMap::new(),
            cursors: Cursors::new(),
            events,
        }))
    }

    /// Subscribe to engine events. Slow subscribers may see `Lagged`.
    pub fn subscribe(&self) -> broadcast::Receiver<EngineEvent> {
        self.events.subscribe()
    }

    fn emit(&self, event: EngineEvent) {
        // No receivers is fine.
        let _ = self.events.send(event);
    }

    /// Close every workspace and the metadata store. Call on app exit.
    pub async fn shutdown(&self) {
        let ids: Vec<WorkspaceId> = self.workspaces.iter().map(|e| e.key().clone()).collect();
        for id in ids {
            let _ = self.workspace_close(&id).await;
        }
        self.store.close().await;
    }

    // ───────────────────────── connections ─────────────────────────

    pub async fn connections_list(&self) -> Result<Vec<ConnectionProfile>, IpcError> {
        self.store.connections_list().await
    }

    /// Assigns an id when empty. `password`: `None` leaves the stored secret
    /// untouched, `Some("")` clears it, `Some(p)` stores it. The password is
    /// never written into the profile JSON.
    pub async fn connections_save(
        &self,
        mut profile: ConnectionProfile,
        password: Option<String>,
    ) -> Result<ConnectionProfile, IpcError> {
        if profile.name.trim().is_empty() {
            return Err(IpcError::invalid("Connection name is required"));
        }
        if profile.id.trim().is_empty() {
            profile.id = uuid::Uuid::new_v4().to_string();
        }
        let existing = self.store.connection_get(&profile.id).await?;
        profile.has_password = existing.as_ref().map(|e| e.has_password).unwrap_or(false);
        if profile.last_used_at.is_none() {
            profile.last_used_at = existing.and_then(|e| e.last_used_at);
        }
        let key = password_key(&profile.id);
        match password {
            Some(p) if p.is_empty() => {
                self.secrets.delete(&key)?;
                profile.has_password = false;
            }
            Some(p) => {
                self.secrets.set(&key, &p)?;
                profile.has_password = true;
            }
            None => {}
        }
        self.store.connection_save(&profile).await?;
        Ok(profile)
    }

    /// Closes any open workspace on the connection, removes its secret and
    /// the profile.
    pub async fn connections_delete(&self, id: &str) -> Result<(), IpcError> {
        let open: Vec<WorkspaceId> = self
            .workspaces
            .iter()
            .filter(|e| e.info.connection_id == id)
            .map(|e| e.key().clone())
            .collect();
        for ws in open {
            let _ = self.workspace_close(&ws).await;
        }
        let _ = self.secrets.delete(&password_key(id));
        if !self.store.connection_delete(id).await? {
            return Err(IpcError::not_found(format!("Connection {id} not found")));
        }
        Ok(())
    }

    /// Staged connectivity test. Never fails for a failed stage; the report
    /// says which stage broke. `password = None` uses the stored secret when
    /// the profile has an id.
    pub async fn connection_test(
        &self,
        profile: ConnectionProfile,
        password: Option<String>,
    ) -> Result<TestReport, IpcError> {
        let password = match password {
            Some(p) => Some(p),
            None if !profile.id.is_empty() => self.secrets.get(&password_key(&profile.id))?,
            None => None,
        };
        let mut stages = Vec::new();
        let read_only = profile.policy == PolicyMode::ReadOnly;

        let t = Instant::now();
        let driver = match self
            .factory
            .connect(
                &profile,
                password.as_deref(),
                profile.database.as_deref(),
                read_only,
            )
            .await
        {
            Ok(d) => {
                stages.push(TestStage {
                    name: "connect".into(),
                    ok: true,
                    duration_ms: ms(t),
                    error: None,
                });
                d
            }
            Err(e) => {
                stages.push(TestStage {
                    name: "connect".into(),
                    ok: false,
                    duration_ms: ms(t),
                    error: Some(e.message),
                });
                return Ok(TestReport {
                    ok: false,
                    stages,
                    server_version: None,
                });
            }
        };

        let t = Instant::now();
        let queried = match driver.ping().await {
            Ok(()) => driver.server_version().await.map(Some),
            Err(e) => Err(e),
        };
        let (ok, server_version) = match queried {
            Ok(v) => {
                stages.push(TestStage {
                    name: "query".into(),
                    ok: true,
                    duration_ms: ms(t),
                    error: None,
                });
                (true, v)
            }
            Err(e) => {
                stages.push(TestStage {
                    name: "query".into(),
                    ok: false,
                    duration_ms: ms(t),
                    error: Some(e.message),
                });
                (false, None)
            }
        };
        driver.close().await;
        Ok(TestReport {
            ok,
            stages,
            server_version,
        })
    }

    // ───────────────────────── workspaces ─────────────────────────

    pub async fn workspace_open(
        &self,
        connection_id: &str,
        database: Option<String>,
    ) -> Result<WorkspaceInfo, IpcError> {
        let mut profile = self
            .store
            .connection_get(connection_id)
            .await?
            .ok_or_else(|| IpcError::not_found(format!("Connection {connection_id} not found")))?;
        let password = if profile.has_password {
            self.secrets.get(&password_key(connection_id))?
        } else {
            None
        };
        let read_only = profile.policy == PolicyMode::ReadOnly;
        let driver = self
            .factory
            .connect(
                &profile,
                password.as_deref(),
                database.as_deref(),
                read_only,
            )
            .await?;

        let current = driver.current_database();
        let databases = match driver.list_databases().await {
            Ok(list) if !list.is_empty() => list,
            Ok(_) => vec![current.clone()],
            Err(e) => {
                tracing::warn!(connection = %connection_id, error = %e, "list_databases failed");
                vec![current.clone()]
            }
        };
        let server_version = driver.server_version().await.ok();

        let info = WorkspaceInfo {
            id: uuid::Uuid::new_v4().to_string(),
            connection_id: profile.id.clone(),
            connection_name: profile.name.clone(),
            driver: profile.driver,
            environment: profile.environment,
            policy: profile.policy,
            database: current,
            databases,
            server_version,
            tls: driver.tls(),
        };

        profile.last_used_at = Some(now_rfc3339());
        if let Err(e) = self.store.connection_save(&profile).await {
            tracing::warn!(error = %e, "could not update last_used_at");
        }

        self.workspaces.insert(
            info.id.clone(),
            Arc::new(Workspace {
                // Same default as the window's: on for production, and for a
                // read-only connection where it changes nothing anyway.
                safe_mode: AtomicBool::new(
                    info.policy == PolicyMode::ReadOnly || info.environment == Environment::Production,
                ),
                info: info.clone(),
                driver,
                schema_cache: RwLock::new(None),
                table_schemas: DashMap::new(),
            }),
        );
        self.emit(EngineEvent::ConnectionState {
            workspace_id: info.id.clone(),
            state: ConnectionState::Up,
            detail: None,
        });
        Ok(info)
    }

    /// The toolbar padlock. The window owns the preference and remembers it;
    /// the engine owns the enforcement.
    pub fn workspace_set_safe_mode(&self, workspace_id: &str, on: bool) -> Result<(), IpcError> {
        let ws = self.workspace(workspace_id)?;
        ws.safe_mode.store(on, Ordering::Relaxed);
        Ok(())
    }

    pub async fn workspace_close(&self, workspace_id: &str) -> Result<(), IpcError> {
        let (_, ws) = self
            .workspaces
            .remove(workspace_id)
            .ok_or_else(|| IpcError::not_found(format!("Workspace {workspace_id} not found")))?;
        self.cursors.close_workspace(workspace_id);
        ws.driver.close().await;
        self.emit(EngineEvent::ConnectionState {
            workspace_id: workspace_id.to_string(),
            state: ConnectionState::Down,
            detail: None,
        });
        Ok(())
    }

    pub async fn workspace_list(&self) -> Result<Vec<WorkspaceInfo>, IpcError> {
        Ok(self.workspaces.iter().map(|e| e.info.clone()).collect())
    }

    fn workspace(&self, workspace_id: &str) -> Result<Arc<Workspace>, IpcError> {
        self.workspaces
            .get(workspace_id)
            .map(|e| e.value().clone())
            .ok_or_else(|| IpcError::not_found(format!("Workspace {workspace_id} not found")))
    }

    // ───────────────────────── console ─────────────────────────

    async fn log(
        &self,
        ws: &Workspace,
        source: ConsoleSource,
        sql: String,
        duration_ms: u64,
        rows: Option<u64>,
        error: Option<String>,
    ) {
        let entry = NewConsoleEntry {
            workspace_id: Some(ws.info.id.clone()),
            connection_id: ws.info.connection_id.clone(),
            source,
            sql,
            duration_ms,
            rows,
            error,
        };
        match self.store.console_append(entry).await {
            Ok(entry) => self.emit(EngineEvent::ConsoleAppended { entry }),
            Err(e) => tracing::warn!(error = %e, "console append failed"),
        }
    }

    // ───────────────────────── schema ─────────────────────────

    /// The schema as a graph — the map, and the join paths the AI pane walks.
    /// Declared foreign keys come from the driver in one round trip; the rest
    /// is derived from the index, so this is cheap after the first call.
    pub async fn schema_graph(&self, workspace_id: &str, refresh: bool) -> Result<SchemaGraph, IpcError> {
        let index = self.schema_index(workspace_id, refresh).await?;
        let ws = self.workspace(workspace_id)?;
        let t = Instant::now();
        let declared = ws.driver.foreign_keys().await;
        let duration = ms(t);
        match declared {
            Ok(declared) => {
                self.log(&ws, ConsoleSource::App, "schema graph: foreign keys".into(), duration, Some(declared.len() as u64), None).await;
                Ok(crate::graph::build(&index, declared))
            }
            Err(e) => {
                self.log(&ws, ConsoleSource::App, "schema graph: foreign keys".into(), duration, None, Some(e.message.clone())).await;
                Err(e)
            }
        }
    }

    /// Compare two open databases. `left` is the source of truth — usually
    /// local — and the diff describes what `right` is missing.
    ///
    /// Both sides are workspaces, so both are already connected and both go
    /// through the same policy and console as everything else. Nothing is
    /// written: a diff is four `SELECT`s per side.
    pub async fn schema_diff(&self, left_workspace: &str, right_workspace: &str) -> Result<SchemaDiff, IpcError> {
        if left_workspace == right_workspace {
            return Err(IpcError::invalid("Pick two different databases to compare"));
        }
        let left = self.workspace(left_workspace)?;
        let right = self.workspace(right_workspace)?;

        let t = Instant::now();
        let (l, r) = futures::join!(left.driver.schema_snapshot(), right.driver.schema_snapshot());
        let duration = ms(t);
        let (l, r) = (l?, r?);

        let label = |ws: &Workspace| format!("{} · {}", ws.info.connection_name, ws.info.database);
        self.log(&left, ConsoleSource::App, "schema snapshot".into(), duration, Some(l.tables.len() as u64), None).await;
        self.log(&right, ConsoleSource::App, "schema snapshot".into(), duration, Some(r.tables.len() as u64), None).await;
        Ok(crate::diff::compare(&l, &r, &label(&left), &label(&right)))
    }

    /// The `ALTER`s that make the right side match the left. Generated from
    /// the diff the person just looked at, never from a fresh introspection —
    /// so the SQL matches the screen.
    pub fn migration_sql(&self, workspace_id: &str, diff: &SchemaDiff) -> Result<String, IpcError> {
        let ws = self.workspace(workspace_id)?;
        Ok(crate::diff::migration_sql(diff, ws.info.driver))
    }

    pub async fn schema_index(
        &self,
        workspace_id: &str,
        refresh: bool,
    ) -> Result<SchemaIndex, IpcError> {
        let ws = self.workspace(workspace_id)?;
        if !refresh {
            if let Some(cached) = ws.schema_cache.read().as_ref() {
                return Ok(cached.clone());
            }
        }
        if refresh {
            ws.table_schemas.clear();
        }
        let t = Instant::now();
        let result = ws.driver.schema_index().await;
        let duration = ms(t);
        match &result {
            Ok(index) => {
                let objects: usize = index.schemas.iter().map(|s| s.objects.len()).sum();
                self.log(
                    &ws,
                    ConsoleSource::App,
                    "schema introspection".into(),
                    duration,
                    Some(objects as u64),
                    None,
                )
                .await;
            }
            Err(e) => {
                self.log(
                    &ws,
                    ConsoleSource::App,
                    "schema introspection".into(),
                    duration,
                    None,
                    Some(e.message.clone()),
                )
                .await;
            }
        }
        let index = result?;
        *ws.schema_cache.write() = Some(index.clone());
        Ok(index)
    }

    pub async fn table_describe(
        &self,
        workspace_id: &str,
        table: TableRef,
    ) -> Result<TableSchema, IpcError> {
        let ws = self.workspace(workspace_id)?;
        self.describe_cached(&ws, &table).await
    }

    async fn describe_cached(
        &self,
        ws: &Workspace,
        table: &TableRef,
    ) -> Result<TableSchema, IpcError> {
        if let Some(s) = ws.table_schemas.get(table) {
            return Ok(s.clone());
        }
        let t = Instant::now();
        let result = ws.driver.describe_table(table).await;
        let label = format!("describe {}", ws.driver.quote_table(table));
        match &result {
            Ok(_) => {
                self.log(ws, ConsoleSource::App, label, ms(t), None, None)
                    .await
            }
            Err(e) => {
                self.log(
                    ws,
                    ConsoleSource::App,
                    label,
                    ms(t),
                    None,
                    Some(e.message.clone()),
                )
                .await
            }
        }
        let schema = result?;
        ws.table_schemas.insert(table.clone(), schema.clone());
        Ok(schema)
    }

    pub async fn table_open(
        &self,
        workspace_id: &str,
        table: TableRef,
        query: TableQuery,
    ) -> Result<QueryResult, IpcError> {
        let ws = self.workspace(workspace_id)?;
        let schema = self.describe_cached(&ws, &table).await?;

        let known: BTreeSet<&str> = schema.columns.iter().map(|c| c.name.as_str()).collect();
        for f in &query.filters {
            if !known.contains(f.column.as_str()) {
                return Err(IpcError::invalid(format!(
                    "Unknown column {:?} in filter",
                    f.column
                )));
            }
        }
        for s in &query.sort {
            if !known.contains(s.column.as_str()) {
                return Err(IpcError::invalid(format!(
                    "Unknown column {:?} in sort",
                    s.column
                )));
            }
        }

        let mut query = query;
        if query.limit.is_none() {
            query.limit = Some(DEFAULT_ROW_LIMIT);
        }
        let sql = ws.driver.build_table_select(&table, &schema, &query);
        let opts = QueryOpts {
            limit: query.limit,
            read_only: ws.read_only(),
            ..QueryOpts::default()
        };
        let mut result = self
            .execute_one(
                &ws,
                sql,
                ConsoleSource::App,
                &opts,
                Some(StatementKind::Select),
            )
            .await;
        // Tag columns with their table so the grid can edit and follow FKs.
        for col in &mut result.columns {
            if col.table.is_none() && known.contains(col.name.as_str()) {
                col.table = Some(table.clone());
            }
        }
        Ok(result)
    }

    pub async fn table_count(
        &self,
        workspace_id: &str,
        table: TableRef,
        exact: bool,
    ) -> Result<u64, IpcError> {
        let ws = self.workspace(workspace_id)?;
        let t = Instant::now();
        let result = ws.driver.count(&table, exact).await;
        let label = format!(
            "{} count {}",
            if exact { "exact" } else { "estimated" },
            ws.driver.quote_table(&table)
        );
        match &result {
            Ok(n) => {
                self.log(&ws, ConsoleSource::App, label, ms(t), Some(*n), None)
                    .await
            }
            Err(e) => {
                self.log(
                    &ws,
                    ConsoleSource::App,
                    label,
                    ms(t),
                    None,
                    Some(e.message.clone()),
                )
                .await
            }
        }
        result
    }

    // ───────────────────────── queries ─────────────────────────

    /// Split, classify, police and run. Stops at the first failing statement
    /// (policy refusal or driver error) and returns the results so far plus
    /// the failed one.
    /// Run the policy engine over SQL without executing it — what the AI pane
    /// needs before it offers a Run button. Same `classify` + `check` the real
    /// run uses, so the answer can't drift from what would actually happen.
    pub fn sql_check(&self, workspace_id: &str, sql: &str) -> Result<SqlCheck, IpcError> {
        let ws = self.workspace(workspace_id)?;
        let policy = ws.info.policy;
        let safe = ws.safe_mode();
        let statements: Vec<StatementCheck> = policy::split_statements(ws.info.driver, sql)
            .into_iter()
            .map(|stmt| {
                let c = policy::classify(ws.info.driver, &stmt);
                // The dry run has to answer the question the real run will
                // answer, padlock included — otherwise the UI offers a button
                // for something the engine is about to refuse.
                let blocked = policy::check(policy, &c, &stmt)
                    .and_then(|()| if safe { policy::check_safe_mode(&c, &stmt) } else { Ok(()) })
                    .err();
                StatementCheck {
                    sql: stmt,
                    kind: c.kind,
                    parsed: c.parsed,
                    has_where: c.has_where,
                    is_explain: c.is_explain,
                    allowed: blocked.is_none(),
                    blocked_reason: blocked.map(|e| e.message),
                }
            })
            .collect();
        Ok(SqlCheck {
            read_only: !statements.is_empty()
                && statements
                    .iter()
                    .all(|s| s.parsed && matches!(s.kind, StatementKind::Select)),
            allowed: statements.iter().all(|s| s.allowed),
            statements,
            policy,
        })
    }

    /// Run one statement as if the connection's policy were `full`.
    ///
    /// This is the button behind "blocked by read-write policy". It is
    /// deliberately narrow:
    ///
    /// * **A read-only connection cannot be elevated at all.** Read-only is a
    ///   promise about the connection, not a default to be talked out of.
    /// * **Safe mode still applies.** The padlock says "not right now", which
    ///   is a different statement from "this connection may not do DDL", and
    ///   one click should not answer both.
    /// * It lasts exactly one call. Nothing is remembered.
    ///
    /// The console records it as an elevated run, so the audit log shows who
    /// went around the policy and when.
    pub async fn query_run_elevated(
        &self,
        workspace_id: &str,
        sql: String,
        limit: Option<u32>,
        source: ConsoleSource,
    ) -> Result<Vec<QueryResult>, IpcError> {
        let ws = self.workspace(workspace_id)?;
        if ws.info.policy == PolicyMode::ReadOnly {
            return Err(IpcError::policy(
                "This connection is read-only. Change its policy in the connection settings to write to it.",
            ));
        }
        if ws.safe_mode() {
            return Err(IpcError::policy(
                "Safe mode is on. Unlock the padlock first — it is a separate decision from the connection's policy.",
            ));
        }
        let opts = QueryOpts { limit, read_only: false, ..QueryOpts::default() };
        let statements = policy::split_statements(ws.info.driver, &sql);
        let mut results = Vec::with_capacity(statements.len());
        for stmt in statements {
            self.log(&ws, ConsoleSource::App, format!("-- policy elevated for one run\n{stmt}"), 0, None, None)
                .await;
            // `Full` is what elevation means: classify and run as if the
            // connection had been configured that way, for this call only.
            let classified = policy::classify(ws.info.driver, &stmt);
            let r = match policy::check(PolicyMode::Full, &classified, &stmt) {
                Ok(()) => self.execute_one(&ws, stmt, source, &opts, Some(classified.kind)).await,
                Err(e) => return Err(e),
            };
            let failed = r.error.is_some();
            results.push(r);
            if failed {
                break;
            }
        }
        Ok(results)
    }

    /// `EXPLAIN` with hypothetical indexes, on one connection.
    ///
    /// Read-only by construction — it plans, it does not execute — but the
    /// statement is still classified, because `EXPLAIN` of a `DELETE` is only
    /// harmless while nobody adds `ANALYZE` to it.
    pub async fn explain_hypothetical(
        &self,
        workspace_id: &str,
        sql: String,
        indexes: Vec<String>,
    ) -> Result<String, IpcError> {
        let ws = self.workspace(workspace_id)?;
        let classified = policy::classify(ws.info.driver, &sql);
        if !matches!(classified.kind, StatementKind::Select) || !classified.parsed {
            return Err(IpcError::invalid(
                "Only a read-only statement can be planned with hypothetical indexes.",
            ));
        }
        let t = std::time::Instant::now();
        let out = ws.driver.explain_hypothetical(&sql, &indexes).await;
        let label = if indexes.is_empty() {
            format!("EXPLAIN (FORMAT JSON) {sql}")
        } else {
            format!("-- with {} hypothetical index(es)\nEXPLAIN (FORMAT JSON) {sql}", indexes.len())
        };
        match &out {
            Ok(_) => self.log(&ws, ConsoleSource::App, label, ms(t), None, None).await,
            Err(e) => self.log(&ws, ConsoleSource::App, label, ms(t), None, Some(e.message.clone())).await,
        }
        out
    }

    pub async fn query_run(
        &self,
        workspace_id: &str,
        sql: String,
        limit: Option<u32>,
        source: ConsoleSource,
    ) -> Result<Vec<QueryResult>, IpcError> {
        let ws = self.workspace(workspace_id)?;
        let statements = policy::split_statements(ws.info.driver, &sql);
        let opts = QueryOpts {
            limit,
            read_only: ws.read_only(),
            ..QueryOpts::default()
        };
        let mut results = Vec::with_capacity(statements.len());
        for stmt in statements {
            let r = self.execute_one(&ws, stmt, source, &opts, None).await;
            let failed = r.error.is_some();
            results.push(r);
            if failed {
                break;
            }
        }
        Ok(results)
    }

    /// Run one statement. `known_kind = Some(..)` skips classification and
    /// the policy check (for SELECTs the engine built itself).
    async fn execute_one(
        &self,
        ws: &Workspace,
        stmt: String,
        source: ConsoleSource,
        opts: &QueryOpts,
        known_kind: Option<StatementKind>,
    ) -> QueryResult {
        let kind = match known_kind {
            Some(k) => k,
            None => {
                let classified = policy::classify(ws.info.driver, &stmt);
                // The connection's policy is asked first, so the message
                // names the constraint that actually binds: telling someone to
                // unlock a padlock when the connection is read-only sends them
                // to a switch that will not move.
                let refusal = policy::check(ws.info.policy, &classified, &stmt).and_then(|()| {
                    if ws.safe_mode() {
                        policy::check_safe_mode(&classified, &stmt)
                    } else {
                        Ok(())
                    }
                });
                if let Err(e) = refusal {
                    self.log(ws, source, stmt.clone(), 0, None, Some(e.message.clone()))
                        .await;
                    return QueryResult {
                        statement: stmt,
                        kind: classified.kind,
                        columns: vec![],
                        cursor_id: None,
                        row_count: None,
                        rows_affected: None,
                        truncated: false,
                        duration_ms: 0,
                        error: Some(QueryError {
                            message: e.message,
                            line: None,
                            column: None,
                            code: Some("policy".into()),
                            blocked_by_policy: true,
                        }),
                    };
                }
                classified.kind
            }
        };

        let t = Instant::now();
        let outcome = ws.driver.execute(&stmt, opts).await;
        let duration_ms = ms(t);

        match outcome {
            Ok(m) => {
                let row_producing = !m.columns.is_empty() || m.rows_affected.is_none();
                let (cursor_id, row_count) = if row_producing {
                    let n = m.rows.len() as u64;
                    let id =
                        self.cursors
                            .insert(&ws.info.id, m.columns.clone(), m.rows, m.truncated);
                    (Some(id), Some(n))
                } else {
                    (None, None)
                };
                let logged_rows = row_count.or(m.rows_affected);
                self.log(ws, source, stmt.clone(), duration_ms, logged_rows, None)
                    .await;
                if kind == StatementKind::Ddl {
                    ws.invalidate_schema();
                    self.emit(EngineEvent::SchemaChanged {
                        workspace_id: ws.info.id.clone(),
                    });
                }
                QueryResult {
                    statement: stmt,
                    kind,
                    columns: m.columns,
                    cursor_id,
                    row_count,
                    rows_affected: m.rows_affected,
                    truncated: m.truncated,
                    duration_ms,
                    error: None,
                }
            }
            Err(e) => {
                self.log(
                    ws,
                    source,
                    stmt.clone(),
                    duration_ms,
                    None,
                    Some(e.message.clone()),
                )
                .await;
                QueryResult {
                    statement: stmt.clone(),
                    kind,
                    columns: vec![],
                    cursor_id: None,
                    row_count: None,
                    rows_affected: None,
                    truncated: false,
                    duration_ms,
                    error: Some(query_error_from(&e, &stmt)),
                }
            }
        }
    }

    pub async fn query_cancel(&self, workspace_id: &str) -> Result<(), IpcError> {
        let ws = self.workspace(workspace_id)?;
        ws.driver.cancel().await
    }

    // ───────────────────────── cursors ─────────────────────────

    pub async fn cursor_fetch(
        &self,
        cursor_id: &str,
        offset: u64,
        len: u32,
    ) -> Result<RowWindow, IpcError> {
        self.cursors
            .fetch(cursor_id, offset, len.min(MAX_FETCH_LEN))
    }

    pub async fn cursor_close(&self, cursor_id: &str) -> Result<(), IpcError> {
        self.cursors.close(cursor_id);
        Ok(())
    }

    // ───────────────────────── editing ─────────────────────────

    async fn prepare_changes(
        &self,
        ws: &Workspace,
        changes: &ChangeSet,
    ) -> Result<(TableSchema, Vec<String>), IpcError> {
        let table = changes
            .table
            .clone()
            .ok_or_else(|| IpcError::invalid("Change set has no target table"))?;
        if ws.info.policy == PolicyMode::ReadOnly {
            return Err(IpcError::policy(
                "Blocked by read-only policy: editing is not allowed on this connection.",
            ));
        }
        let schema = self.describe_cached(ws, &table).await?;
        if schema.primary_key.is_empty() {
            return Err(IpcError::invalid("Table has no primary key — read only"));
        }
        let known: BTreeSet<&str> = schema.columns.iter().map(|c| c.name.as_str()).collect();
        let pk: BTreeSet<&str> = schema.primary_key.iter().map(String::as_str).collect();
        let check_pk = |m: &std::collections::BTreeMap<String, Cell>| -> Result<(), IpcError> {
            for k in pk.iter() {
                if !m.contains_key(*k) {
                    return Err(IpcError::invalid(format!(
                        "Change is missing primary key column {k:?}"
                    )));
                }
            }
            Ok(())
        };
        for u in &changes.updates {
            if !known.contains(u.column.as_str()) {
                return Err(IpcError::invalid(format!("Unknown column {:?}", u.column)));
            }
            check_pk(&u.pk)?;
        }
        for i in &changes.inserts {
            for k in i.values.keys() {
                if !known.contains(k.as_str()) {
                    return Err(IpcError::invalid(format!("Unknown column {k:?}")));
                }
            }
        }
        for d in &changes.deletes {
            check_pk(&d.pk)?;
        }
        if changes.updates.is_empty() && changes.inserts.is_empty() && changes.deletes.is_empty() {
            return Err(IpcError::invalid("Nothing to apply"));
        }
        let statements = ws.driver.render_changes(&schema, changes)?;
        Ok((schema, statements))
    }

    pub async fn changes_preview(
        &self,
        workspace_id: &str,
        changes: ChangeSet,
    ) -> Result<ChangePreview, IpcError> {
        let ws = self.workspace(workspace_id)?;
        let (_, statements) = self.prepare_changes(&ws, &changes).await?;
        let updated_rows: BTreeSet<String> = changes
            .updates
            .iter()
            .map(|u| serde_json::to_string(&u.pk).unwrap_or_default())
            .collect();
        let affected_estimate =
            (updated_rows.len() + changes.inserts.len() + changes.deletes.len()) as u64;
        Ok(ChangePreview {
            statements,
            affected_estimate,
        })
    }

    pub async fn changes_apply(
        &self,
        workspace_id: &str,
        changes: ChangeSet,
    ) -> Result<ChangeOutcome, IpcError> {
        let ws = self.workspace(workspace_id)?;
        let (_, statements) = self.prepare_changes(&ws, &changes).await?;
        let t = Instant::now();
        let result = ws.driver.apply(&statements).await;
        let duration_ms = ms(t);
        let logged = statements.join(";\n");
        match result {
            Ok(rows_affected) => {
                self.log(
                    &ws,
                    ConsoleSource::User,
                    logged,
                    duration_ms,
                    Some(rows_affected),
                    None,
                )
                .await;
                Ok(ChangeOutcome {
                    statements,
                    rows_affected,
                    duration_ms,
                })
            }
            Err(e) => {
                self.log(
                    &ws,
                    ConsoleSource::User,
                    logged,
                    duration_ms,
                    None,
                    Some(e.message.clone()),
                )
                .await;
                Err(e)
            }
        }
    }

    // ───────────────────────── console / history / saved / state ─────────────────────────

    /// Newest first.
    pub async fn console_list(
        &self,
        workspace_id: Option<String>,
        limit: u32,
    ) -> Result<Vec<ConsoleEntry>, IpcError> {
        self.store
            .console_list(workspace_id.as_deref(), limit)
            .await
    }

    /// Newest first; `user` and `ai` sources only.
    pub async fn history_list(
        &self,
        connection_id: &str,
        limit: u32,
    ) -> Result<Vec<ConsoleEntry>, IpcError> {
        self.store.history_list(connection_id, limit).await
    }

    pub async fn saved_list(
        &self,
        connection_id: Option<String>,
    ) -> Result<Vec<SavedQuery>, IpcError> {
        self.store.saved_list(connection_id.as_deref()).await
    }

    /// Assigns an id when empty and stamps `updated_at`.
    pub async fn saved_save(&self, mut query: SavedQuery) -> Result<SavedQuery, IpcError> {
        if query.name.trim().is_empty() {
            return Err(IpcError::invalid("Saved query name is required"));
        }
        if query.id.trim().is_empty() {
            query.id = uuid::Uuid::new_v4().to_string();
        }
        query.updated_at = now_rfc3339();
        self.store.saved_save(&query).await?;
        Ok(query)
    }

    pub async fn saved_delete(&self, id: &str) -> Result<(), IpcError> {
        if !self.store.saved_delete(id).await? {
            return Err(IpcError::not_found(format!("Saved query {id} not found")));
        }
        Ok(())
    }

    /// `Value::Null` when unset.
    pub async fn state_get(&self, key: &str) -> Result<serde_json::Value, IpcError> {
        self.store.state_get(key).await
    }

    /// Setting `Value::Null` removes the key.
    pub async fn state_set(&self, key: &str, value: serde_json::Value) -> Result<(), IpcError> {
        self.store.state_set(key, &value).await
    }
}

fn ms(t: Instant) -> u64 {
    t.elapsed().as_millis() as u64
}

/// Map a driver error into the wire shape, pulling a position / line and an
/// error code out of the text when the server reported one.
pub fn query_error_from(e: &IpcError, stmt: &str) -> QueryError {
    let text = match &e.detail {
        Some(d) => format!("{}\n{}", e.message, d),
        None => e.message.clone(),
    };
    let (line, column) = locate_error(&text, stmt);
    QueryError {
        message: e.message.clone(),
        line,
        column,
        code: find_error_code(&text),
        blocked_by_policy: false,
    }
}

fn number_after(text: &str, markers: &[&str]) -> Option<u32> {
    let lower = text.to_ascii_lowercase();
    for m in markers {
        let mut from = 0;
        while let Some(i) = lower[from..].find(m) {
            let rest = &text[from + i + m.len()..];
            let digits: String = rest
                .trim_start()
                .chars()
                .take_while(|c| c.is_ascii_digit())
                .collect();
            if !digits.is_empty() {
                if let Ok(n) = digits.parse::<u32>() {
                    return Some(n);
                }
            }
            from += i + m.len();
        }
    }
    None
}

/// Postgres reports a 1-based character offset ("position: 42" from the
/// server, "at character 42" in psql-style text); MySQL reports "at line N".
fn locate_error(text: &str, stmt: &str) -> (Option<u32>, Option<u32>) {
    if let Some(pos) = number_after(text, &["position: ", "position ", "at character "]) {
        let target = (pos.max(1) - 1) as usize;
        let mut line = 1u32;
        let mut col = 1u32;
        for (i, ch) in stmt.chars().enumerate() {
            if i == target {
                break;
            }
            if ch == '\n' {
                line += 1;
                col = 1;
            } else {
                col += 1;
            }
        }
        return (Some(line), Some(col));
    }
    if let Some(line) = number_after(text, &["at line "]) {
        return (Some(line), None);
    }
    (None, None)
}

/// SQLSTATE (`42P01`), sqlx's `(code: 1)` style, or `code: XXXXX`.
fn find_error_code(text: &str) -> Option<String> {
    let lower = text.to_ascii_lowercase();
    for m in ["sqlstate: ", "sqlstate ", "code: "] {
        if let Some(i) = lower.find(m) {
            let rest = &text[i + m.len()..];
            let tok: String = rest
                .trim_start()
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
                .collect();
            if !tok.is_empty() {
                return Some(tok);
            }
        }
    }
    None
}

// ───────────────────────── tests ─────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::driver::Materialized;
    use crate::secrets::InMemorySecrets;
    use async_trait::async_trait;
    use parking_lot::Mutex;
    use serde_json::json;
    use std::collections::BTreeMap;

    fn temp_dir() -> PathBuf {
        std::env::temp_dir().join(format!("plinth-engine-test-{}", uuid::Uuid::new_v4()))
    }

    #[derive(Default)]
    struct Recorder {
        connects: Vec<(Option<String>, Option<String>, bool)>,
        executed: Vec<(String, QueryOpts)>,
        schema_calls: usize,
        describe_calls: usize,
        cancelled: usize,
        closed: usize,
        applied: Vec<Vec<String>>,
    }

    struct FakeDriver {
        rec: Arc<Mutex<Recorder>>,
        database: String,
    }

    fn users_table() -> TableRef {
        TableRef {
            schema: Some("public".into()),
            name: "users".into(),
        }
    }

    fn users_schema() -> TableSchema {
        TableSchema {
            table: users_table(),
            kind: ObjectKind::Table,
            columns: vec![
                ColumnInfo {
                    name: "id".into(),
                    data_type: "int8".into(),
                    logical: LogicalType::Int,
                    nullable: false,
                    default: None,
                    is_primary_key: true,
                    ordinal: 1,
                },
                ColumnInfo {
                    name: "name".into(),
                    data_type: "text".into(),
                    logical: LogicalType::Text,
                    nullable: true,
                    default: None,
                    is_primary_key: false,
                    ordinal: 2,
                },
            ],
            primary_key: vec!["id".into()],
            foreign_keys: vec![],
            indexes: vec![],
            ddl: None,
            row_estimate: Some(3),
        }
    }

    fn users_columns() -> Vec<ColumnDesc> {
        vec![
            ColumnDesc {
                name: "id".into(),
                data_type: "int8".into(),
                logical: LogicalType::Int,
                wire: WireKind::String,
                nullable: Some(false),
                table: None,
            },
            ColumnDesc {
                name: "name".into(),
                data_type: "text".into(),
                logical: LogicalType::Text,
                wire: WireKind::String,
                nullable: Some(true),
                table: None,
            },
        ]
    }

    #[async_trait]
    impl Driver for FakeDriver {
        fn kind(&self) -> DriverKind {
            DriverKind::Postgres
        }
        async fn server_version(&self) -> Result<String, IpcError> {
            Ok("FakeSQL 1.0".into())
        }
        fn tls(&self) -> bool {
            true
        }
        async fn ping(&self) -> Result<(), IpcError> {
            Ok(())
        }
        async fn list_databases(&self) -> Result<Vec<String>, IpcError> {
            Ok(vec!["app".into(), "other".into()])
        }
        fn current_database(&self) -> String {
            self.database.clone()
        }
        async fn schema_index(&self) -> Result<SchemaIndex, IpcError> {
            self.rec.lock().schema_calls += 1;
            Ok(SchemaIndex {
                schemas: vec![SchemaInfo {
                    name: "public".into(),
                    is_system: false,
                    objects: vec![ObjectInfo {
                        schema: "public".into(),
                        name: "users".into(),
                        kind: ObjectKind::Table,
                        row_estimate: Some(3),
                    }],
                }],
                columns: vec![
                    ColumnRef {
                        schema: "public".into(),
                        table: "users".into(),
                        column: "id".into(),
                    },
                    ColumnRef {
                        schema: "public".into(),
                        table: "users".into(),
                        column: "name".into(),
                    },
                ],
                generated_at: now_rfc3339(),
            })
        }
        async fn foreign_keys(&self) -> Result<Vec<GraphEdge>, IpcError> {
            Ok(vec![])
        }

        async fn schema_snapshot(&self) -> Result<SchemaSnapshot, IpcError> {
            Ok(SchemaSnapshot { tables: vec![], foreign_keys: vec![], generated_at: String::new() })
        }

        async fn describe_table(&self, table: &TableRef) -> Result<TableSchema, IpcError> {
            self.rec.lock().describe_calls += 1;
            if table.name == "users" {
                Ok(users_schema())
            } else if table.name == "nopk" {
                let mut s = users_schema();
                s.table = table.clone();
                s.primary_key.clear();
                Ok(s)
            } else {
                Err(IpcError::not_found(format!(
                    "relation {} does not exist",
                    table.name
                )))
            }
        }
        async fn count(&self, _table: &TableRef, exact: bool) -> Result<u64, IpcError> {
            Ok(if exact { 3 } else { 300 })
        }
        async fn execute(&self, sql: &str, opts: &QueryOpts) -> Result<Materialized, IpcError> {
            self.rec
                .lock()
                .executed
                .push((sql.to_string(), opts.clone()));
            let lower = sql.to_ascii_lowercase();
            if let Some(at) = lower.find("boom") {
                return Err(IpcError::driver(format!(
                    "ERROR: syntax error at or near \"boom\"\nposition: {}",
                    at + 1
                )));
            }
            if lower.starts_with("select") || lower.starts_with("explain") {
                let all: Vec<Vec<Cell>> = (1..=5)
                    .map(|i| vec![json!(i.to_string()), json!(format!("user{i}"))])
                    .collect();
                let limit = opts.limit.unwrap_or(1000) as usize;
                let truncated = all.len() > limit;
                let rows = all.into_iter().take(limit).collect();
                Ok(Materialized {
                    columns: users_columns(),
                    rows,
                    truncated,
                    rows_affected: None,
                })
            } else {
                Ok(Materialized {
                    rows_affected: Some(1),
                    ..Default::default()
                })
            }
        }
        async fn cancel(&self) -> Result<(), IpcError> {
            self.rec.lock().cancelled += 1;
            Ok(())
        }
        fn quote_ident(&self, ident: &str) -> String {
            format!("\"{}\"", ident.replace('"', "\"\""))
        }
        fn build_table_select(
            &self,
            table: &TableRef,
            _schema: &TableSchema,
            query: &TableQuery,
        ) -> String {
            let mut s = format!("SELECT * FROM {}", self.quote_table(table));
            if let Some(f) = query.filters.first() {
                s.push_str(&format!(
                    " WHERE {} = '{}'",
                    self.quote_ident(&f.column),
                    f.value.clone().unwrap_or_default()
                ));
            }
            if let Some(o) = query.sort.first() {
                s.push_str(&format!(" ORDER BY {}", self.quote_ident(&o.column)));
            }
            if let Some(l) = query.limit {
                s.push_str(&format!(" LIMIT {l}"));
            }
            s
        }
        fn render_changes(
            &self,
            schema: &TableSchema,
            changes: &ChangeSet,
        ) -> Result<Vec<String>, IpcError> {
            let mut out = Vec::new();
            for u in &changes.updates {
                out.push(format!(
                    "UPDATE {} SET {} = {} WHERE id = {}",
                    self.quote_table(&schema.table),
                    self.quote_ident(&u.column),
                    u.value,
                    u.pk.get("id").cloned().unwrap_or(json!(null))
                ));
            }
            for d in &changes.deletes {
                out.push(format!(
                    "DELETE FROM {} WHERE id = {}",
                    self.quote_table(&schema.table),
                    d.pk.get("id").cloned().unwrap_or(json!(null))
                ));
            }
            for i in &changes.inserts {
                out.push(format!(
                    "INSERT INTO {} VALUES ({})",
                    self.quote_table(&schema.table),
                    i.values.len()
                ));
            }
            Ok(out)
        }
        async fn apply(&self, statements: &[String]) -> Result<u64, IpcError> {
            self.rec.lock().applied.push(statements.to_vec());
            Ok(statements.len() as u64)
        }
        async fn close(&self) {
            self.rec.lock().closed += 1;
        }
    }

    struct FakeFactory {
        rec: Arc<Mutex<Recorder>>,
        fail_connect: bool,
    }

    #[async_trait]
    impl DriverFactory for FakeFactory {
        async fn connect(
            &self,
            profile: &ConnectionProfile,
            password: Option<&str>,
            database: Option<&str>,
            read_only: bool,
        ) -> Result<Arc<dyn Driver>, IpcError> {
            self.rec.lock().connects.push((
                password.map(String::from),
                database.map(String::from),
                read_only,
            ));
            if self.fail_connect {
                return Err(IpcError::driver("connection refused"));
            }
            let database = database
                .map(String::from)
                .or_else(|| profile.database.clone())
                .unwrap_or_else(|| "app".into());
            Ok(Arc::new(FakeDriver {
                rec: self.rec.clone(),
                database,
            }))
        }
    }

    fn profile(policy: PolicyMode) -> ConnectionProfile {
        ConnectionProfile {
            id: String::new(),
            name: "Fake".into(),
            driver: DriverKind::Postgres,
            environment: Environment::Local,
            policy,
            color: None,
            host: Some("localhost".into()),
            port: Some(5432),
            database: Some("app".into()),
            user: Some("me".into()),
            file_path: None,
            ssl: SslMode::Prefer,
            has_password: false,
            last_used_at: None,
            favorite: false,
            folder: None,
            statement_timeout_ms: None,
        }
    }

    async fn setup(
        fail_connect: bool,
    ) -> (Arc<Engine>, Arc<Mutex<Recorder>>, Arc<InMemorySecrets>) {
        let rec = Arc::new(Mutex::new(Recorder::default()));
        let secrets = Arc::new(InMemorySecrets::new());
        let factory = Arc::new(FakeFactory {
            rec: rec.clone(),
            fail_connect,
        });
        let engine = Engine::new(temp_dir(), secrets.clone(), factory)
            .await
            .expect("engine");
        (engine, rec, secrets)
    }

    fn drain(rx: &mut broadcast::Receiver<EngineEvent>) -> Vec<EngineEvent> {
        let mut out = Vec::new();
        while let Ok(e) = rx.try_recv() {
            out.push(e);
        }
        out
    }

    #[tokio::test]
    async fn end_to_end_read_only_workspace() {
        let (engine, rec, secrets) = setup(false).await;
        let mut rx = engine.subscribe();

        // connections_save assigns an id and stores the password in secrets only.
        let saved = engine
            .connections_save(profile(PolicyMode::ReadOnly), Some("hunter2".into()))
            .await
            .expect("save");
        assert!(!saved.id.is_empty());
        assert!(saved.has_password);
        assert_eq!(
            secrets
                .get(&password_key(&saved.id))
                .expect("get")
                .as_deref(),
            Some("hunter2")
        );
        let listed = engine.connections_list().await.expect("list");
        assert_eq!(listed.len(), 1);
        assert!(!serde_json::to_string(&listed[0])
            .expect("json")
            .contains("hunter2"));

        // connection_test reports stages.
        let report = engine
            .connection_test(saved.clone(), None)
            .await
            .expect("test");
        assert!(report.ok);
        assert_eq!(
            report
                .stages
                .iter()
                .map(|s| s.name.as_str())
                .collect::<Vec<_>>(),
            vec!["connect", "query"]
        );
        assert!(report.stages.iter().all(|s| s.ok));
        assert_eq!(report.server_version.as_deref(), Some("FakeSQL 1.0"));
        assert_eq!(
            rec.lock().connects.last().map(|c| c.0.clone()),
            Some(Some("hunter2".into()))
        );

        // workspace_open resolves the password and read_only from the policy.
        let ws = engine
            .workspace_open(&saved.id, Some("other".into()))
            .await
            .expect("open");
        assert_eq!(ws.connection_id, saved.id);
        assert_eq!(ws.database, "other");
        assert_eq!(ws.databases, vec!["app", "other"]);
        assert_eq!(ws.server_version.as_deref(), Some("FakeSQL 1.0"));
        assert!(ws.tls);
        assert_eq!(ws.policy, PolicyMode::ReadOnly);
        {
            let r = rec.lock();
            let last = r.connects.last().expect("connect recorded");
            assert_eq!(last, &(Some("hunter2".into()), Some("other".into()), true));
        }
        let profile_after = engine.connections_list().await.expect("list").remove(0);
        assert!(profile_after.last_used_at.is_some());
        let events = drain(&mut rx);
        assert!(events.iter().any(|e| matches!(e, EngineEvent::ConnectionState { workspace_id, state: ConnectionState::Up, .. } if *workspace_id == ws.id)));
        assert_eq!(engine.workspace_list().await.expect("list").len(), 1);

        // schema_index is cached until refresh.
        let idx = engine.schema_index(&ws.id, false).await.expect("schema");
        assert_eq!(idx.schemas[0].objects[0].name, "users");
        engine
            .schema_index(&ws.id, false)
            .await
            .expect("schema cached");
        assert_eq!(rec.lock().schema_calls, 1);
        engine
            .schema_index(&ws.id, true)
            .await
            .expect("schema refresh");
        assert_eq!(rec.lock().schema_calls, 2);
        let console = engine
            .console_list(Some(ws.id.clone()), 10)
            .await
            .expect("console");
        assert!(console
            .iter()
            .any(|e| e.sql == "schema introspection" && e.source == ConsoleSource::App));
        assert!(drain(&mut rx)
            .iter()
            .any(|e| matches!(e, EngineEvent::ConsoleAppended { .. })));

        // table_describe caches.
        engine
            .table_describe(&ws.id, users_table())
            .await
            .expect("describe");
        engine
            .table_describe(&ws.id, users_table())
            .await
            .expect("describe cached");
        assert_eq!(rec.lock().describe_calls, 1);

        // table_open validates columns, defaults the limit and returns a cursor.
        let bad = engine
            .table_open(
                &ws.id,
                users_table(),
                TableQuery {
                    filters: vec![Filter {
                        column: "nope".into(),
                        op: FilterOp::Eq,
                        value: Some("1".into()),
                    }],
                    ..Default::default()
                },
            )
            .await;
        assert_eq!(bad.err().map(|e| e.code), Some("invalid".into()));
        let r = engine
            .table_open(
                &ws.id,
                users_table(),
                TableQuery {
                    filters: vec![],
                    sort: vec![Sort {
                        column: "name".into(),
                        dir: SortDir::Asc,
                    }],
                    limit: Some(2),
                    offset: None,
                },
            )
            .await
            .expect("table_open");
        assert!(r.error.is_none());
        assert_eq!(r.kind, StatementKind::Select);
        assert_eq!(r.row_count, Some(2));
        assert!(r.truncated);
        assert_eq!(r.columns[0].table.as_ref(), Some(&users_table()));
        let cursor = r.cursor_id.clone().expect("cursor");
        {
            let r = rec.lock();
            let (sql, opts) = r.executed.last().expect("executed");
            assert!(sql.contains("ORDER BY \"name\" LIMIT 2"), "{sql}");
            assert!(opts.read_only);
            assert_eq!(opts.limit, Some(2));
        }
        let r2 = engine
            .table_open(&ws.id, users_table(), TableQuery::default())
            .await
            .expect("table_open");
        assert_eq!(r2.row_count, Some(5));
        assert!(!r2.truncated);
        assert!(rec
            .lock()
            .executed
            .last()
            .expect("executed")
            .0
            .ends_with("LIMIT 1000"));

        // cursor_fetch serves windows.
        let w = engine.cursor_fetch(&cursor, 0, 1).await.expect("fetch");
        assert_eq!(w.rows, vec![vec![json!("1"), json!("user1")]]);
        assert_eq!(w.buffered, 2);
        assert!(!w.exhausted);
        assert!(w.truncated);
        let w = engine.cursor_fetch(&cursor, 1, 10).await.expect("fetch");
        assert_eq!(w.rows.len(), 1);
        assert!(w.exhausted);

        // query_run: policy refusal stops the batch after the failing statement.
        let before = rec.lock().executed.len();
        let results = engine
            .query_run(
                &ws.id,
                "select 1; update users set name = 'x' where id = 1; select 2".into(),
                Some(3),
                ConsoleSource::User,
            )
            .await
            .expect("query_run");
        assert_eq!(results.len(), 2, "stop at first error");
        assert!(results[0].error.is_none());
        assert_eq!(results[0].kind, StatementKind::Select);
        assert_eq!(results[0].row_count, Some(3));
        assert!(results[0].truncated);
        assert!(results[0].cursor_id.is_some());
        let blocked = results[1].error.as_ref().expect("blocked");
        assert!(blocked.blocked_by_policy);
        assert_eq!(
            blocked.message,
            "Blocked by read-only policy: UPDATE is not allowed on this connection."
        );
        assert_eq!(results[1].kind, StatementKind::Update);
        assert_eq!(
            rec.lock().executed.len(),
            before + 1,
            "only the SELECT reached the driver"
        );

        // Unparseable input fails closed under read-only.
        let results = engine
            .query_run(&ws.id, "frobnicate all".into(), None, ConsoleSource::Ai)
            .await
            .expect("run");
        assert!(results[0]
            .error
            .as_ref()
            .map(|e| e.blocked_by_policy)
            .unwrap_or(false));

        // Driver errors are mapped with position → line/column.
        let results = engine
            .query_run(&ws.id, "select\n boom".into(), None, ConsoleSource::User)
            .await
            .expect("run");
        let err = results[0].error.as_ref().expect("driver error");
        assert!(!err.blocked_by_policy);
        assert_eq!((err.line, err.column), (Some(2), Some(2)));

        // Console + history.
        let console = engine
            .console_list(Some(ws.id.clone()), 100)
            .await
            .expect("console");
        let user_entries: Vec<_> = console
            .iter()
            .filter(|e| e.source == ConsoleSource::User)
            .collect();
        assert!(user_entries
            .iter()
            .any(|e| e.sql == "select 1" && e.rows == Some(3) && e.error.is_none()));
        assert!(user_entries
            .iter()
            .any(|e| e.sql.starts_with("update users")
                && e.error
                    .as_deref()
                    .map(|m| m.contains("read-only"))
                    .unwrap_or(false)));
        assert!(console
            .iter()
            .any(|e| e.source == ConsoleSource::Ai && e.sql == "frobnicate all"));
        let history = engine.history_list(&saved.id, 100).await.expect("history");
        assert!(!history.is_empty());
        assert!(history.iter().all(|e| e.source != ConsoleSource::App));
        assert!(engine.console_list(None, 1).await.expect("console").len() == 1);

        // Editing is refused under read-only, before the driver is asked.
        let changes = ChangeSet {
            table: Some(users_table()),
            updates: vec![CellChange {
                pk: BTreeMap::from([("id".into(), json!("1"))]),
                column: "name".into(),
                value: json!("Zed"),
            }],
            ..Default::default()
        };
        assert_eq!(
            engine
                .changes_preview(&ws.id, changes.clone())
                .await
                .err()
                .map(|e| e.code),
            Some("policy".into())
        );
        assert_eq!(
            engine
                .changes_apply(&ws.id, changes)
                .await
                .err()
                .map(|e| e.code),
            Some("policy".into())
        );

        // cancel / close.
        engine.query_cancel(&ws.id).await.expect("cancel");
        assert_eq!(rec.lock().cancelled, 1);
        engine.workspace_close(&ws.id).await.expect("close");
        assert!(
            engine.cursor_fetch(&cursor, 0, 1).await.is_err(),
            "cursors die with the workspace"
        );
        assert!(engine.workspace_list().await.expect("list").is_empty());
        assert!(drain(&mut rx).iter().any(|e| matches!(
            e,
            EngineEvent::ConnectionState {
                state: ConnectionState::Down,
                ..
            }
        )));
        assert_eq!(
            engine.workspace_close(&ws.id).await.err().map(|e| e.code),
            Some("not-found".into())
        );
        assert!(
            rec.lock().closed >= 2,
            "test driver and workspace driver both closed"
        );

        // connections_delete removes the secret.
        engine.connections_delete(&saved.id).await.expect("delete");
        assert_eq!(secrets.get(&password_key(&saved.id)).expect("get"), None);
        assert!(engine.connections_list().await.expect("list").is_empty());
        assert_eq!(
            engine
                .connections_delete(&saved.id)
                .await
                .err()
                .map(|e| e.code),
            Some("not-found".into())
        );
    }

    #[tokio::test]
    async fn read_write_workspace_edits_and_ddl_invalidation() {
        let (engine, rec, _) = setup(false).await;
        let saved = engine
            .connections_save(profile(PolicyMode::ReadWrite), None)
            .await
            .expect("save");
        assert!(!saved.has_password);
        let ws = engine.workspace_open(&saved.id, None).await.expect("open");
        assert_eq!(ws.database, "app");
        assert_eq!(rec.lock().connects.last().map(|c| c.2), Some(false));

        // No table / no PK / unknown column.
        assert_eq!(
            engine
                .changes_preview(&ws.id, ChangeSet::default())
                .await
                .err()
                .map(|e| e.code),
            Some("invalid".into())
        );
        let nopk = ChangeSet {
            table: Some(TableRef {
                schema: None,
                name: "nopk".into(),
            }),
            deletes: vec![RowDelete {
                pk: BTreeMap::from([("id".into(), json!("1"))]),
            }],
            ..Default::default()
        };
        let e = engine
            .changes_preview(&ws.id, nopk)
            .await
            .expect_err("no pk");
        assert_eq!(e.code, "invalid");
        assert!(e.message.contains("no primary key"));
        let unknown = ChangeSet {
            table: Some(users_table()),
            updates: vec![CellChange {
                pk: BTreeMap::from([("id".into(), json!("1"))]),
                column: "ghost".into(),
                value: json!(1),
            }],
            ..Default::default()
        };
        assert!(engine.changes_preview(&ws.id, unknown).await.is_err());
        let missing_pk = ChangeSet {
            table: Some(users_table()),
            updates: vec![CellChange {
                pk: BTreeMap::new(),
                column: "name".into(),
                value: json!(1),
            }],
            ..Default::default()
        };
        assert!(engine.changes_preview(&ws.id, missing_pk).await.is_err());

        let changes = ChangeSet {
            table: Some(users_table()),
            updates: vec![
                CellChange {
                    pk: BTreeMap::from([("id".into(), json!("1"))]),
                    column: "name".into(),
                    value: json!("Zed"),
                },
                CellChange {
                    pk: BTreeMap::from([("id".into(), json!("1"))]),
                    column: "id".into(),
                    value: json!("9"),
                },
            ],
            inserts: vec![RowInsert {
                values: BTreeMap::from([("name".into(), json!("new"))]),
            }],
            deletes: vec![RowDelete {
                pk: BTreeMap::from([("id".into(), json!("2"))]),
            }],
        };
        let preview = engine
            .changes_preview(&ws.id, changes.clone())
            .await
            .expect("preview");
        assert_eq!(preview.statements.len(), 4);
        assert_eq!(
            preview.affected_estimate, 3,
            "two updates on one row count once"
        );
        assert!(rec.lock().applied.is_empty());

        let outcome = engine.changes_apply(&ws.id, changes).await.expect("apply");
        assert_eq!(outcome.rows_affected, 4);
        assert_eq!(outcome.statements, preview.statements);
        assert_eq!(rec.lock().applied.len(), 1);
        let console = engine
            .console_list(Some(ws.id.clone()), 10)
            .await
            .expect("console");
        assert_eq!(console[0].source, ConsoleSource::User);
        assert!(console[0].sql.contains("UPDATE") && console[0].sql.contains("DELETE"));
        assert_eq!(console[0].rows, Some(4));

        // Read-write policy: UPDATE without WHERE blocked, DDL blocked, DML with WHERE runs.
        let results = engine
            .query_run(
                &ws.id,
                "update users set name = 'a' where id = 1; delete from users; select 1".into(),
                None,
                ConsoleSource::User,
            )
            .await
            .expect("run");
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].rows_affected, Some(1));
        assert!(results[0].cursor_id.is_none());
        assert!(results[1]
            .error
            .as_ref()
            .expect("blocked")
            .message
            .contains("requires a WHERE clause"));
        let results = engine
            .query_run(&ws.id, "drop table users".into(), None, ConsoleSource::User)
            .await
            .expect("run");
        assert!(
            results[0]
                .error
                .as_ref()
                .expect("blocked")
                .blocked_by_policy
        );

        // Full policy: DDL runs and invalidates the schema cache.
        let mut full = engine.connections_list().await.expect("list").remove(0);
        full.policy = PolicyMode::Full;
        engine.connections_save(full, None).await.expect("save");
        let ws2 = engine.workspace_open(&saved.id, None).await.expect("open");
        let mut rx = engine.subscribe();
        engine.schema_index(&ws2.id, false).await.expect("schema");
        let calls = rec.lock().schema_calls;
        let results = engine
            .query_run(
                &ws2.id,
                "create table t (a int)".into(),
                None,
                ConsoleSource::User,
            )
            .await
            .expect("run");
        assert!(results[0].error.is_none());
        assert_eq!(results[0].kind, StatementKind::Ddl);
        assert!(drain(&mut rx).iter().any(
            |e| matches!(e, EngineEvent::SchemaChanged { workspace_id } if *workspace_id == ws2.id)
        ));
        engine.schema_index(&ws2.id, false).await.expect("schema");
        assert_eq!(
            rec.lock().schema_calls,
            calls + 1,
            "DDL invalidated the cache"
        );

        assert_eq!(
            engine
                .table_count(&ws2.id, users_table(), true)
                .await
                .expect("count"),
            3
        );
        assert_eq!(
            engine
                .table_count(&ws2.id, users_table(), false)
                .await
                .expect("count"),
            300
        );

        engine.shutdown().await;
        assert!(engine.workspace_list().await.expect("list").is_empty());
    }

    #[tokio::test]
    async fn connection_test_reports_failed_stage() {
        let (engine, _, _) = setup(true).await;
        let report = engine
            .connection_test(profile(PolicyMode::ReadOnly), Some("x".into()))
            .await
            .expect("test");
        assert!(!report.ok);
        assert_eq!(report.stages.len(), 1);
        assert_eq!(report.stages[0].name, "connect");
        assert!(!report.stages[0].ok);
        assert_eq!(
            report.stages[0].error.as_deref(),
            Some("connection refused")
        );
        assert!(report.server_version.is_none());

        let saved = engine
            .connections_save(profile(PolicyMode::ReadOnly), None)
            .await
            .expect("save");
        assert_eq!(
            engine
                .workspace_open(&saved.id, None)
                .await
                .err()
                .map(|e| e.code),
            Some("driver".into())
        );
        assert_eq!(
            engine
                .workspace_open("missing", None)
                .await
                .err()
                .map(|e| e.code),
            Some("not-found".into())
        );
    }

    #[tokio::test]
    async fn password_lifecycle_and_metadata() {
        let (engine, _, secrets) = setup(false).await;
        let p = engine
            .connections_save(profile(PolicyMode::ReadOnly), Some("one".into()))
            .await
            .expect("save");
        let key = password_key(&p.id);
        // None keeps the secret and the flag.
        let p2 = engine
            .connections_save(p.clone(), None)
            .await
            .expect("save");
        assert!(p2.has_password);
        assert_eq!(secrets.get(&key).expect("get").as_deref(), Some("one"));
        // Some("") clears.
        let p3 = engine
            .connections_save(p.clone(), Some(String::new()))
            .await
            .expect("save");
        assert!(!p3.has_password);
        assert_eq!(secrets.get(&key).expect("get"), None);
        // Empty name rejected.
        let mut bad = p.clone();
        bad.name = " ".into();
        assert_eq!(
            engine
                .connections_save(bad, None)
                .await
                .err()
                .map(|e| e.code),
            Some("invalid".into())
        );

        // Saved queries.
        let q = engine
            .saved_save(SavedQuery {
                id: String::new(),
                connection_id: Some(p.id.clone()),
                name: "top users".into(),
                folder: None,
                sql: "select 1".into(),
                updated_at: String::new(),
            })
            .await
            .expect("save");
        assert!(!q.id.is_empty());
        assert!(!q.updated_at.is_empty());
        engine
            .saved_save(SavedQuery {
                id: String::new(),
                connection_id: None,
                name: "shared".into(),
                folder: Some("f".into()),
                sql: "select 2".into(),
                updated_at: String::new(),
            })
            .await
            .expect("save");
        assert_eq!(
            engine
                .saved_list(Some(p.id.clone()))
                .await
                .expect("list")
                .len(),
            2
        );
        assert_eq!(
            engine
                .saved_list(Some("other".into()))
                .await
                .expect("list")
                .len(),
            1
        );
        assert_eq!(engine.saved_list(None).await.expect("list").len(), 2);
        engine.saved_delete(&q.id).await.expect("delete");
        assert_eq!(
            engine.saved_delete(&q.id).await.err().map(|e| e.code),
            Some("not-found".into())
        );

        // KV state.
        assert_eq!(
            engine.state_get("ui.layout").await.expect("get"),
            json!(null)
        );
        engine
            .state_set("ui.layout", json!({"sidebar": 280}))
            .await
            .expect("set");
        assert_eq!(
            engine.state_get("ui.layout").await.expect("get"),
            json!({"sidebar": 280})
        );
    }

    #[test]
    fn error_position_mapping() {
        let e = IpcError::driver("ERROR: syntax error at or near \"x\"\nposition: 12");
        let q = query_error_from(&e, "select 1\nfrom x y");
        assert_eq!((q.line, q.column), (Some(2), Some(3)));

        let e = IpcError::driver("You have an error in your SQL syntax near 'x' at line 3");
        let q = query_error_from(&e, "a\nb\nc");
        assert_eq!((q.line, q.column), (Some(3), None));

        let e =
            IpcError::driver("error returned from database: (code: 1) near \"x\": syntax error");
        let q = query_error_from(&e, "x");
        assert_eq!(q.code.as_deref(), Some("1"));
        assert_eq!((q.line, q.column), (None, None));

        let mut e = IpcError::driver("relation \"t\" does not exist");
        e.detail = Some("SQLSTATE: 42P01".into());
        let q = query_error_from(&e, "select * from t");
        assert_eq!(q.code.as_deref(), Some("42P01"));
        assert_eq!(q.message, "relation \"t\" does not exist");
        assert!(!q.blocked_by_policy);
    }
}
