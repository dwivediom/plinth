//! `plinth-mcp` — a stdio MCP server over the same engine and data directory
//! the Plinth app uses. See `docs/PLAN.md` §5 and `README.md` in this crate.

pub mod secrets;
pub mod server;

use plinth_core::{Engine, IpcError};
use plinth_drivers::SqlxFactory;
use std::path::PathBuf;
use std::sync::Arc;

/// Bundle identifier from `src-tauri/tauri.conf.json`; Tauri's
/// `app_data_dir()` is `<platform data dir>/<identifier>`.
pub const APP_IDENTIFIER: &str = "dev.plinth.app";

/// The directory the desktop app stores `plinth.db` in:
/// - macOS: `~/Library/Application Support/dev.plinth.app`
/// - Linux: `$XDG_DATA_HOME/dev.plinth.app` (default `~/.local/share/dev.plinth.app`)
/// - Windows: `%APPDATA%\dev.plinth.app`
pub fn default_data_dir() -> Option<PathBuf> {
    directories::BaseDirs::new().map(|b| b.data_dir().join(APP_IDENTIFIER))
}

/// Open the engine the way the app does: same store, OS keychain, sqlx drivers.
pub async fn open_engine(data_dir: PathBuf) -> Result<Arc<Engine>, IpcError> {
    Engine::new(data_dir, secrets::open_secrets(), Arc::new(SqlxFactory)).await
}
