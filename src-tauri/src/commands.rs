//! One `#[tauri::command]` per entry in the IPC catalogue
//! (`crates/core/src/ipc.rs`). Argument names are the snake_case form of the
//! camelCase keys the UI sends (`src/ipc/types.ts`): Tauri does the conversion.

use plinth_core::*;
use std::sync::Arc;
use tauri::State;
use tauri_plugin_dialog::DialogExt;

type Eng<'a> = State<'a, Arc<Engine>>;

// ───────────────────────── connections ─────────────────────────

#[tauri::command]
pub async fn connections_list(engine: Eng<'_>) -> Result<Vec<ConnectionProfile>, IpcError> {
    engine.connections_list().await
}

#[tauri::command]
pub async fn connections_save(
    engine: Eng<'_>,
    profile: ConnectionProfile,
    password: Option<String>,
) -> Result<ConnectionProfile, IpcError> {
    engine.connections_save(profile, password).await
}

#[tauri::command]
pub async fn connections_delete(engine: Eng<'_>, id: String) -> Result<(), IpcError> {
    engine.connections_delete(&id).await
}

#[tauri::command]
pub async fn connection_test(
    engine: Eng<'_>,
    profile: ConnectionProfile,
    password: Option<String>,
) -> Result<TestReport, IpcError> {
    engine.connection_test(profile, password).await
}

// ───────────────────────── workspaces ─────────────────────────

#[tauri::command]
pub async fn workspace_open(
    engine: Eng<'_>,
    connection_id: String,
    database: Option<String>,
) -> Result<WorkspaceInfo, IpcError> {
    engine.workspace_open(&connection_id, database).await
}

/// The toolbar padlock. The window remembers the preference; the engine is
/// what actually refuses the statement.
#[tauri::command]
pub async fn workspace_set_safe_mode(
    engine: Eng<'_>,
    workspace_id: String,
    on: bool,
) -> Result<(), IpcError> {
    engine.workspace_set_safe_mode(&workspace_id, on)
}

#[tauri::command]
pub async fn workspace_close(engine: Eng<'_>, workspace_id: String) -> Result<(), IpcError> {
    engine.workspace_close(&workspace_id).await
}

#[tauri::command]
pub async fn workspace_list(engine: Eng<'_>) -> Result<Vec<WorkspaceInfo>, IpcError> {
    engine.workspace_list().await
}

// ───────────────────────── schema ─────────────────────────

#[tauri::command]
pub async fn schema_index(
    engine: Eng<'_>,
    workspace_id: String,
    refresh: bool,
) -> Result<SchemaIndex, IpcError> {
    engine.schema_index(&workspace_id, refresh).await
}

#[tauri::command]
pub async fn schema_graph(
    engine: Eng<'_>,
    workspace_id: String,
    refresh: bool,
) -> Result<SchemaGraph, IpcError> {
    engine.schema_graph(&workspace_id, refresh).await
}

#[tauri::command]
pub async fn schema_diff(
    engine: Eng<'_>,
    left_workspace_id: String,
    right_workspace_id: String,
) -> Result<SchemaDiff, IpcError> {
    engine.schema_diff(&left_workspace_id, &right_workspace_id).await
}

#[tauri::command]
pub async fn migration_sql(engine: Eng<'_>, workspace_id: String, diff: SchemaDiff) -> Result<String, IpcError> {
    engine.migration_sql(&workspace_id, &diff)
}

#[tauri::command]
pub async fn table_describe(
    engine: Eng<'_>,
    workspace_id: String,
    table: TableRef,
) -> Result<TableSchema, IpcError> {
    engine.table_describe(&workspace_id, table).await
}

#[tauri::command]
pub async fn table_open(
    engine: Eng<'_>,
    workspace_id: String,
    table: TableRef,
    query: TableQuery,
) -> Result<QueryResult, IpcError> {
    engine.table_open(&workspace_id, table, query).await
}

#[tauri::command]
pub async fn table_count(
    engine: Eng<'_>,
    workspace_id: String,
    table: TableRef,
    exact: bool,
) -> Result<u64, IpcError> {
    engine.table_count(&workspace_id, table, exact).await
}

// ───────────────────────── queries ─────────────────────────

/// Run one statement as if the connection's policy were `full`, once.
///
/// The engine decides whether that is allowed at all: a read-only connection
/// never is, safe mode still applies, and nothing about the elevation is
/// remembered afterwards. The console records it as an elevated run.
#[tauri::command]
pub async fn query_run_elevated(
    engine: Eng<'_>,
    workspace_id: String,
    sql: String,
    limit: Option<u32>,
) -> Result<Vec<QueryResult>, IpcError> {
    engine
        .query_run_elevated(&workspace_id, sql, limit, ConsoleSource::User)
        .await
}

#[tauri::command]
pub async fn query_run(
    engine: Eng<'_>,
    workspace_id: String,
    sql: String,
    limit: Option<u32>,
    source: Option<String>,
) -> Result<Vec<QueryResult>, IpcError> {
    // Provenance for the audit log: SQL a model wrote is logged as AI even
    // though a person pressed Run, so the console's AI filter tells the truth.
    let source = match source.as_deref() {
        Some("ai") => ConsoleSource::Ai,
        _ => ConsoleSource::User,
    };
    engine.query_run(&workspace_id, sql, limit, source).await
}

/// Plan a statement with hypothetical indexes — how the optimiser measures an
/// index without anyone building it.
#[tauri::command]
pub async fn explain_hypothetical(
    engine: Eng<'_>,
    workspace_id: String,
    sql: String,
    indexes: Vec<String>,
) -> Result<String, IpcError> {
    engine.explain_hypothetical(&workspace_id, sql, indexes).await
}

/// Dry-run the policy engine over SQL the AI pane is about to offer.
#[tauri::command]
pub async fn sql_check(
    engine: Eng<'_>,
    workspace_id: String,
    sql: String,
) -> Result<SqlCheck, IpcError> {
    engine.sql_check(&workspace_id, &sql)
}

#[tauri::command]
pub async fn query_cancel(engine: Eng<'_>, workspace_id: String) -> Result<(), IpcError> {
    engine.query_cancel(&workspace_id).await
}

#[tauri::command]
pub async fn cursor_fetch(
    engine: Eng<'_>,
    cursor_id: String,
    offset: u64,
    len: u32,
) -> Result<RowWindow, IpcError> {
    engine.cursor_fetch(&cursor_id, offset, len).await
}

#[tauri::command]
pub async fn cursor_close(engine: Eng<'_>, cursor_id: String) -> Result<(), IpcError> {
    engine.cursor_close(&cursor_id).await
}

// ───────────────────────── editing ─────────────────────────

#[tauri::command]
pub async fn changes_preview(
    engine: Eng<'_>,
    workspace_id: String,
    changes: ChangeSet,
) -> Result<ChangePreview, IpcError> {
    engine.changes_preview(&workspace_id, changes).await
}

#[tauri::command]
pub async fn changes_apply(
    engine: Eng<'_>,
    workspace_id: String,
    changes: ChangeSet,
) -> Result<ChangeOutcome, IpcError> {
    engine.changes_apply(&workspace_id, changes).await
}

// ───────────────────────── console / history / saved ─────────────────────────

#[tauri::command]
pub async fn console_list(
    engine: Eng<'_>,
    workspace_id: Option<String>,
    limit: u32,
) -> Result<Vec<ConsoleEntry>, IpcError> {
    engine.console_list(workspace_id, limit).await
}

#[tauri::command]
pub async fn history_list(
    engine: Eng<'_>,
    connection_id: String,
    limit: u32,
) -> Result<Vec<ConsoleEntry>, IpcError> {
    engine.history_list(&connection_id, limit).await
}

#[tauri::command]
pub async fn saved_list(
    engine: Eng<'_>,
    connection_id: Option<String>,
) -> Result<Vec<SavedQuery>, IpcError> {
    engine.saved_list(connection_id).await
}

#[tauri::command]
pub async fn saved_save(engine: Eng<'_>, query: SavedQuery) -> Result<SavedQuery, IpcError> {
    engine.saved_save(query).await
}

#[tauri::command]
pub async fn saved_delete(engine: Eng<'_>, id: String) -> Result<(), IpcError> {
    engine.saved_delete(&id).await
}

// ───────────────────────── state ─────────────────────────

#[tauri::command]
pub async fn state_get(engine: Eng<'_>, key: String) -> Result<serde_json::Value, IpcError> {
    engine.state_get(&key).await
}

#[tauri::command]
pub async fn state_set(
    engine: Eng<'_>,
    key: String,
    value: serde_json::Value,
) -> Result<(), IpcError> {
    engine.state_set(&key, value).await
}

// ───────────────────────── tauri-only ─────────────────────────

/// Native open-file dialog filtered to SQLite extensions. `None` when the
/// user cancels. Runs on the async runtime, so the blocking picker is fine.
#[tauri::command]
pub async fn sqlite_pick_file(app: tauri::AppHandle) -> Result<Option<String>, IpcError> {
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("Open SQLite database")
            .add_filter("SQLite databases", &["db", "sqlite", "sqlite3", "db3"])
            .add_filter("All files", &["*"])
            .blocking_pick_file()
    })
    .await
    .map_err(IpcError::internal)?;
    Ok(picked.map(|p| match p.clone().into_path() {
        Ok(path) => path.to_string_lossy().into_owned(),
        Err(_) => p.to_string(),
    }))
}
