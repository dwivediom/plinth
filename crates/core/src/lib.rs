//! plinth-core — the engine. See docs/PLAN.md §3–§4 and §8.
//!
//! Module map:
//! - `ipc`     the wire contract (mirrored in src/ipc/types.ts)
//! - `driver`  the `Driver` / `DriverFactory` traits
//! - `secrets` the `SecretStore` trait (OS keychain in the app, in-memory in tests)
//! - `policy`  statement splitting + classification + policy checks (sqlparser)
//! - `store`   local SQLite metadata: profiles, console, history, saved queries, kv state
//! - `cursor`  buffered row windows
//! - `engine`  `Engine`: one method per command in the catalogue
pub mod bigjson;
pub mod cursor;
pub mod driver;
pub mod diff;
pub mod engine;
pub mod graph;
pub mod ipc;
pub mod policy;
pub mod secrets;
pub mod store;

pub use cursor::Cursors;
pub use driver::*;
pub use engine::Engine;
pub use ipc::*;
pub use secrets::{password_key, InMemorySecrets, SecretStore};
pub use store::Store;
