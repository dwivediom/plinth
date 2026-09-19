//! OS-keychain `SecretStore` for the MCP binary — a copy of `src-tauri/src/secrets.rs`.
//!
//! Every secret is a `keyring::Entry` under service `dev.plinth.app` with the
//! engine's key (`plinth:connection:<id>`) as the user name. When the platform
//! store cannot be initialised (headless Linux without a Secret Service, CI)
//! we fall back to `InMemorySecrets` and log a warning so the app still runs;
//! passwords then live only for the lifetime of the process.
//!
//! Keep in sync with `src-tauri/src/secrets.rs`; the two are duplicated so
//! this binary reads the app's keychain entries without a shared crate.

use keyring::{Entry, Error as KeyringError};
use plinth_core::{IpcError, InMemorySecrets, SecretStore};
use std::sync::Arc;

pub const SERVICE: &str = "dev.plinth.app";

pub struct KeyringSecrets;

impl KeyringSecrets {
    fn entry(key: &str) -> Result<Entry, IpcError> {
        Entry::new(SERVICE, key).map_err(map_err)
    }
}

fn map_err(e: KeyringError) -> IpcError {
    IpcError::new("io", format!("keychain: {e}"))
}

impl SecretStore for KeyringSecrets {
    fn get(&self, key: &str) -> Result<Option<String>, IpcError> {
        match Self::entry(key)?.get_password() {
            Ok(p) => Ok(Some(p)),
            Err(KeyringError::NoEntry) => Ok(None),
            Err(e) => Err(map_err(e)),
        }
    }

    fn set(&self, key: &str, value: &str) -> Result<(), IpcError> {
        Self::entry(key)?.set_password(value).map_err(map_err)
    }

    fn delete(&self, key: &str) -> Result<(), IpcError> {
        match Self::entry(key)?.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
            Err(e) => Err(map_err(e)),
        }
    }
}

/// The keychain when it is available, otherwise a process-local store.
pub fn open_secrets() -> Arc<dyn SecretStore> {
    match Entry::store_status() {
        Ok(()) => Arc::new(KeyringSecrets),
        Err(e) => {
            tracing::warn!(
                error = %e,
                "OS keychain unavailable; passwords will not persist across restarts"
            );
            Arc::new(InMemorySecrets::new())
        }
    }
}
