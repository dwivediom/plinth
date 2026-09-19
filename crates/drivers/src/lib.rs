//! plinth-drivers — sqlx-backed drivers implementing `plinth_core::Driver`
//! for SQLite, PostgreSQL and MySQL.
//!
//! Module map:
//! - `value`    row → wire-cell decoding (the type-fidelity rules)
//! - `sql`      identifier quoting, literals, data-view `SELECT`, change rendering
//! - `exec`     shared streaming execution with limit / timeout
//! - `sqlite`, `postgres`, `mysql`  the three `Driver` implementations
//! - `SqlxFactory`  builds a driver from a `ConnectionProfile`

pub mod exec;
pub mod mysql;
pub mod postgres;
pub mod sql;
pub mod sqlite;
pub mod value;

pub use mysql::MysqlDriver;
pub use postgres::PostgresDriver;
pub use sqlite::SqliteDriver;

use async_trait::async_trait;
use plinth_core::*;
use sqlx::mysql::{MySqlConnectOptions, MySqlSslMode};
use sqlx::postgres::{PgConnectOptions, PgSslMode};
use std::sync::Arc;

pub const DEFAULT_PG_PORT: u16 = 5432;
pub const DEFAULT_MYSQL_PORT: u16 = 3306;

/// The engine's `DriverFactory`: dispatches on `profile.driver`.
#[derive(Debug, Default, Clone, Copy)]
pub struct SqlxFactory;

impl SqlxFactory {
    /// Postgres connect options for a profile (exposed for tests and tooling).
    pub fn pg_options(profile: &ConnectionProfile, password: Option<&str>, database: Option<&str>) -> PgConnectOptions {
        let mut o = PgConnectOptions::new()
            .host(profile.host.as_deref().unwrap_or("localhost"))
            .port(profile.port.unwrap_or(DEFAULT_PG_PORT))
            .ssl_mode(match profile.ssl {
                SslMode::Disable => PgSslMode::Disable,
                SslMode::Prefer => PgSslMode::Prefer,
                SslMode::Require => PgSslMode::Require,
            })
            .application_name("plinth");
        if let Some(u) = profile.user.as_deref().filter(|u| !u.is_empty()) {
            o = o.username(u);
        }
        if let Some(p) = password {
            o = o.password(p);
        }
        if let Some(db) = database.or(profile.database.as_deref()).filter(|d| !d.is_empty()) {
            o = o.database(db);
        }
        o
    }

    /// MySQL connect options for a profile.
    pub fn mysql_options(profile: &ConnectionProfile, password: Option<&str>, database: Option<&str>) -> MySqlConnectOptions {
        let mut o = MySqlConnectOptions::new()
            .host(profile.host.as_deref().unwrap_or("localhost"))
            .port(profile.port.unwrap_or(DEFAULT_MYSQL_PORT))
            .ssl_mode(match profile.ssl {
                SslMode::Disable => MySqlSslMode::Disabled,
                SslMode::Prefer => MySqlSslMode::Preferred,
                SslMode::Require => MySqlSslMode::Required,
            });
        if let Some(u) = profile.user.as_deref().filter(|u| !u.is_empty()) {
            o = o.username(u);
        }
        if let Some(p) = password {
            o = o.password(p);
        }
        if let Some(db) = database.or(profile.database.as_deref()).filter(|d| !d.is_empty()) {
            o = o.database(db);
        }
        o
    }
}

#[async_trait]
impl DriverFactory for SqlxFactory {
    async fn connect(
        &self,
        profile: &ConnectionProfile,
        password: Option<&str>,
        database: Option<&str>,
        read_only: bool,
    ) -> Result<Arc<dyn Driver>, IpcError> {
        let limits = SessionLimits { statement_timeout_ms: profile.statement_timeout_ms };
        match profile.driver {
            DriverKind::Sqlite => {
                let path = profile
                    .file_path
                    .as_deref()
                    .or(database)
                    .or(profile.database.as_deref())
                    .filter(|p| !p.is_empty())
                    .ok_or_else(|| IpcError::invalid("SQLite profile has no file path"))?;
                Ok(Arc::new(SqliteDriver::connect(path, read_only).await?))
            }
            DriverKind::Postgres => {
                let opts = Self::pg_options(profile, password, database);
                Ok(Arc::new(PostgresDriver::connect(opts, read_only, limits).await?))
            }
            DriverKind::Mysql => {
                let opts = Self::mysql_options(profile, password, database);
                Ok(Arc::new(MysqlDriver::connect(opts, read_only, limits).await?))
            }
        }
    }
}
