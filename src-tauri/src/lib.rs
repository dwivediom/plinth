//! Plinth desktop shell: wires `plinth_core::Engine` to Tauri commands,
//! forwards engine events to the webview, installs the native menu bar and
//! (on macOS) the sidebar vibrancy.

mod ai;
mod commands;
mod menu;
mod secrets;
mod windows;

use plinth_core::Engine;
use plinth_drivers::SqlxFactory;
use std::sync::Arc;
use tauri::{Emitter, Manager, RunEvent};
use tokio::sync::broadcast::error::RecvError;

/// Event channel for engine events (`EngineEvent`, tagged by `type`).
pub const ENGINE_EVENT: &str = "plinth://event";

fn init_tracing() {
    use tracing_subscriber::EnvFilter;
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .try_init();
}

/// Forward `engine.subscribe()` to the webview until the sender is dropped.
async fn forward_events(app: tauri::AppHandle, engine: Arc<Engine>) {
    let mut rx = engine.subscribe();
    loop {
        match rx.recv().await {
            Ok(event) => {
                if let Err(e) = app.emit(ENGINE_EVENT, &event) {
                    tracing::warn!(error = %e, "engine event emit failed");
                }
            }
            Err(RecvError::Lagged(n)) => {
                // The UI re-syncs from `console_list` / `workspace_list`; just note it.
                tracing::warn!(skipped = n, "engine event stream lagged");
            }
            Err(RecvError::Closed) => break,
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_tracing();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .menu(menu::build)
        .on_menu_event(menu::on_event)
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            tracing::info!(path = %data_dir.display(), "data dir");

            let secrets = secrets::open_secrets();
            let factory = Arc::new(SqlxFactory);
            let engine = tauri::async_runtime::block_on(Engine::new(data_dir, secrets, factory))
                .map_err(|e| std::io::Error::other(e.to_string()))?;

            app.manage(engine.clone());
            app.manage(Arc::new(ai::AiState::default()));
            tauri::async_runtime::spawn(forward_events(app.handle().clone(), engine));

            #[cfg(target_os = "macos")]
            if let Some(window) = app.get_webview_window("main") {
                use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};
                if let Err(e) = apply_vibrancy(&window, NSVisualEffectMaterial::Sidebar, None, None) {
                    tracing::warn!(error = %e, "vibrancy unavailable");
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::connections_list,
            commands::connections_save,
            commands::connections_delete,
            commands::connection_test,
            commands::workspace_open,
            commands::workspace_close,
            commands::workspace_set_safe_mode,
            commands::workspace_list,
            commands::schema_index,
            commands::schema_graph,
            commands::schema_diff,
            commands::migration_sql,
            commands::table_describe,
            commands::table_open,
            commands::table_count,
            commands::query_run,
            commands::query_run_elevated,
            commands::query_cancel,
            commands::sql_check,
            commands::explain_hypothetical,
            commands::cursor_fetch,
            commands::cursor_close,
            commands::changes_preview,
            commands::changes_apply,
            commands::console_list,
            commands::history_list,
            commands::saved_list,
            commands::saved_save,
            commands::saved_delete,
            commands::state_get,
            commands::state_set,
            commands::sqlite_pick_file,
            windows::window_open,
            windows::window_focus,
            windows::window_list,
            ai::ai_probe,
            ai::ai_ollama_install,
            ai::ai_ollama_start,
            ai::ai_model_pull,
            ai::ai_mcp_connect,
            ai::ai_ask,
            ai::ai_step,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            if let Some(engine) = app.try_state::<Arc<Engine>>() {
                let engine = engine.inner().clone();
                tauri::async_runtime::block_on(async move {
                    // Bound the wait so a wedged pool never blocks quitting.
                    let _ = tokio::time::timeout(
                        std::time::Duration::from_secs(5),
                        engine.shutdown(),
                    )
                    .await;
                });
            }
        }
    });
}
