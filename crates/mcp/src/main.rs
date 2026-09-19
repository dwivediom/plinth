//! `plinth-mcp [--data-dir <dir>]` — stdio MCP server.
//!
//! stdout is the JSON-RPC transport, so all logging goes to stderr
//! (`RUST_LOG` controls the level; default `info`).

use rmcp::transport::stdio;
use rmcp::ServiceExt;
use std::path::PathBuf;
use std::process::ExitCode;

fn usage() -> ! {
    eprintln!(
        "usage: plinth-mcp [--data-dir <dir>]\n\n\
         Serves the Model Context Protocol over stdin/stdout for the connections\n\
         configured in the Plinth app. --data-dir overrides the app's data directory\n\
         (default: {}).",
        plinth_mcp::default_data_dir()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|| "<unknown on this platform>".into())
    );
    std::process::exit(2)
}

fn parse_args() -> Option<PathBuf> {
    let mut args = std::env::args().skip(1);
    let mut data_dir = None;
    while let Some(a) = args.next() {
        match a.as_str() {
            "--data-dir" => data_dir = Some(PathBuf::from(args.next().unwrap_or_else(|| usage()))),
            s if s.starts_with("--data-dir=") => {
                data_dir = Some(PathBuf::from(&s["--data-dir=".len()..]))
            }
            _ => usage(),
        }
    }
    data_dir
}

#[tokio::main]
async fn main() -> ExitCode {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .with_target(false)
        .try_init();

    let data_dir = match parse_args().or_else(plinth_mcp::default_data_dir) {
        Some(d) => d,
        None => {
            eprintln!("plinth-mcp: cannot determine the data directory; pass --data-dir");
            return ExitCode::from(2);
        }
    };
    tracing::info!(path = %data_dir.display(), "opening Plinth data dir");

    let engine = match plinth_mcp::open_engine(data_dir).await {
        Ok(e) => e,
        Err(e) => {
            eprintln!("plinth-mcp: could not open the Plinth store: {e}");
            return ExitCode::from(1);
        }
    };

    let handler = plinth_mcp::server::PlinthMcp::new(engine.clone());
    let code = match handler.serve(stdio()).await {
        Ok(service) => match service.waiting().await {
            Ok(reason) => {
                tracing::info!(?reason, "client disconnected");
                ExitCode::SUCCESS
            }
            Err(e) => {
                tracing::error!(error = %e, "server task failed");
                ExitCode::from(1)
            }
        },
        Err(e) => {
            tracing::error!(error = %e, "MCP initialisation failed");
            ExitCode::from(1)
        }
    };

    engine.shutdown().await;
    code
}
