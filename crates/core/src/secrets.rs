//! Secret storage behind a trait so the engine never knows where passwords
//! live. The Tauri shell wires an OS-keychain implementation; tests and the
//! MCP server can use [`InMemorySecrets`].

use crate::ipc::IpcError;
use parking_lot::Mutex;
use std::collections::HashMap;

pub trait SecretStore: Send + Sync {
    fn get(&self, key: &str) -> Result<Option<String>, IpcError>;
    fn set(&self, key: &str, value: &str) -> Result<(), IpcError>;
    fn delete(&self, key: &str) -> Result<(), IpcError>;
}

/// Process-local secret store. Nothing is persisted.
#[derive(Default)]
pub struct InMemorySecrets(Mutex<HashMap<String, String>>);

impl InMemorySecrets {
    pub fn new() -> Self {
        Self::default()
    }
}

impl SecretStore for InMemorySecrets {
    fn get(&self, key: &str) -> Result<Option<String>, IpcError> {
        Ok(self.0.lock().get(key).cloned())
    }
    fn set(&self, key: &str, value: &str) -> Result<(), IpcError> {
        self.0.lock().insert(key.to_string(), value.to_string());
        Ok(())
    }
    fn delete(&self, key: &str) -> Result<(), IpcError> {
        self.0.lock().remove(key);
        Ok(())
    }
}

/// Keychain key under which a connection's password is stored.
pub fn password_key(connection_id: &str) -> String {
    format!("plinth:connection:{connection_id}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn in_memory_round_trip() {
        let s = InMemorySecrets::new();
        let k = password_key("abc");
        assert_eq!(k, "plinth:connection:abc");
        assert_eq!(s.get(&k).ok().flatten(), None);
        s.set(&k, "hunter2").ok();
        assert_eq!(s.get(&k).ok().flatten().as_deref(), Some("hunter2"));
        s.delete(&k).ok();
        assert_eq!(s.get(&k).ok().flatten(), None);
    }
}
