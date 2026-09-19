//! End-to-end smoke test: seed a data dir with a SQLite connection, spawn the
//! `plinth-mcp` binary with `--data-dir`, and speak JSON-RPC over its
//! stdin/stdout. Also exercises the tool bodies in-process for the read-only
//! guardrails that are awkward to assert through the wire.

use plinth_core::*;
use plinth_drivers::SqlxFactory;
use plinth_mcp::server::PlinthMcp;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

struct Fixture {
    data_dir: PathBuf,
    connection_id: String,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.data_dir);
    }
}

/// Fresh data dir + a SQLite profile pointing at a database with `people`.
async fn seed(tag: &str) -> Fixture {
    let data_dir = std::env::temp_dir().join(format!(
        "plinth-mcp-{tag}-{}-{}",
        std::process::id(),
        uuid_ish()
    ));
    std::fs::create_dir_all(&data_dir).expect("mkdir");
    let db_path = data_dir.join("fixture.sqlite");

    let engine = Engine::new(
        data_dir.clone(),
        Arc::new(InMemorySecrets::new()),
        Arc::new(SqlxFactory),
    )
    .await
    .expect("engine");

    let profile = ConnectionProfile {
        id: String::new(),
        name: "Fixture".into(),
        driver: DriverKind::Sqlite,
        environment: Environment::Local,
        policy: PolicyMode::Full, // for seeding DDL; flipped to ReadWrite below
        color: None,
        host: None,
        port: None,
        database: None,
        user: None,
        file_path: Some(db_path.to_string_lossy().into_owned()),
        ssl: SslMode::default(),
        has_password: false,
        last_used_at: None,
        favorite: false,
        folder: None,
        statement_timeout_ms: None,
    };
    let saved = engine.connections_save(profile, None).await.expect("save");
    let ws = engine.workspace_open(&saved.id, None).await.expect("open");
    for sql in [
        "CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL, age INTEGER)",
        "INSERT INTO people (name, age) VALUES ('Ada', 36), ('Linus', 54), ('Grace', 85)",
        "CREATE TABLE orders (id INTEGER PRIMARY KEY, person_id INTEGER REFERENCES people(id), total REAL)",
    ] {
        let results = engine
            .query_run(&ws.id, sql.into(), None, ConsoleSource::App)
            .await
            .expect("run");
        if let Some(err) = results.iter().find_map(|r| r.error.as_ref()) {
            panic!("seed failed: {}", err.message);
        }
    }
    engine.workspace_close(&ws.id).await.expect("close");
    // The MCP server must refuse writes even on a read-write connection.
    let mut profile = saved;
    profile.policy = PolicyMode::ReadWrite;
    let saved = engine.connections_save(profile, None).await.expect("resave");
    engine.shutdown().await;

    Fixture { data_dir, connection_id: saved.id }
}

fn uuid_ish() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

fn tool_text(result: &Value) -> Value {
    let text = result["result"]["content"][0]["text"]
        .as_str()
        .unwrap_or_else(|| panic!("no text content in {result}"));
    serde_json::from_str(text).unwrap_or_else(|e| panic!("tool text is not JSON ({e}): {text}"))
}

#[tokio::test]
async fn stdio_end_to_end() {
    let fx = seed("stdio").await;

    let mut child = Command::new(env!("CARGO_BIN_EXE_plinth-mcp"))
        .arg("--data-dir")
        .arg(&fx.data_dir)
        .env("RUST_LOG", "warn")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .expect("spawn plinth-mcp");
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("stdout")).lines();

    let mut next_id = 0u64;
    let mut call = |method: &str, params: Value| -> (u64, String) {
        next_id += 1;
        let msg = json!({ "jsonrpc": "2.0", "id": next_id, "method": method, "params": params });
        (next_id, format!("{msg}\n"))
    };

    async fn send(stdin: &mut tokio::process::ChildStdin, line: String) {
        stdin.write_all(line.as_bytes()).await.expect("write");
        stdin.flush().await.expect("flush");
    }

    async fn recv(
        lines: &mut tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
        id: u64,
    ) -> Value {
        loop {
            let line = tokio::time::timeout(Duration::from_secs(30), lines.next_line())
                .await
                .expect("timed out waiting for the server")
                .expect("read")
                .expect("server closed stdout");
            let v: Value = serde_json::from_str(&line).expect("json line");
            if v.get("id").and_then(Value::as_u64) == Some(id) {
                return v;
            }
            // notifications / other traffic
        }
    }

    // initialize
    let (id, line) = call(
        "initialize",
        json!({
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": { "name": "smoke", "version": "0" }
        }),
    );
    send(&mut stdin, line).await;
    let init = recv(&mut stdout, id).await;
    assert_eq!(init["result"]["serverInfo"]["name"], "plinth-mcp");
    assert!(init["result"]["capabilities"]["tools"].is_object());
    assert!(init["result"]["capabilities"]["resources"].is_object());
    assert!(init["result"]["instructions"]
        .as_str()
        .unwrap_or("")
        .contains("READ-ONLY"));
    send(
        &mut stdin,
        format!("{}\n", json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })),
    )
    .await;

    // tools/list
    let (id, line) = call("tools/list", json!({}));
    send(&mut stdin, line).await;
    let tools = recv(&mut stdout, id).await;
    let mut names: Vec<&str> = tools["result"]["tools"]
        .as_array()
        .expect("tools array")
        .iter()
        .filter_map(|t| t["name"].as_str())
        .collect();
    names.sort_unstable();
    assert_eq!(
        names,
        [
            "describe_table",
            "list_connections",
            "list_schemas",
            "list_tables",
            "run_query",
            "sample_rows",
            "search_schema"
        ]
    );
    let run_query = tools["result"]["tools"]
        .as_array()
        .expect("tools")
        .iter()
        .find(|t| t["name"] == "run_query")
        .expect("run_query tool");
    assert!(run_query["inputSchema"]["properties"]["connection_id"].is_object());
    assert!(run_query["inputSchema"]["properties"]["sql"].is_object());

    // tools/call list_connections
    let (id, line) = call("tools/call", json!({ "name": "list_connections", "arguments": {} }));
    send(&mut stdin, line).await;
    let resp = recv(&mut stdout, id).await;
    assert_ne!(resp["result"]["isError"], true, "{resp}");
    let conns = tool_text(&resp);
    let conn = &conns[0];
    assert_eq!(conn["id"], fx.connection_id);
    assert_eq!(conn["driver"], "sqlite");
    assert_eq!(conn["policy"], "read-write");
    assert_eq!(conn["database"], "fixture.sqlite");
    assert!(conn.get("host").is_none() && conn.get("user").is_none() && conn.get("filePath").is_none());

    // tools/call run_query
    let (id, line) = call(
        "tools/call",
        json!({
            "name": "run_query",
            "arguments": {
                "connection_id": fx.connection_id,
                "sql": "SELECT name, age FROM people ORDER BY age",
                "limit": 2
            }
        }),
    );
    send(&mut stdin, line).await;
    let resp = recv(&mut stdout, id).await;
    assert_ne!(resp["result"]["isError"], true, "{resp}");
    let out = tool_text(&resp);
    assert_eq!(out["columns"][0]["name"], "name");
    assert_eq!(out["columns"][1]["name"], "age");
    assert_eq!(out["rows"][0][0], "Ada");
    assert_eq!(out["rowCount"], 2);
    assert_eq!(out["truncated"], true, "limit 2 of 3 rows must report truncation");

    // writes are refused even though the profile is read-write
    let (id, line) = call(
        "tools/call",
        json!({
            "name": "run_query",
            "arguments": { "connection_id": fx.connection_id, "sql": "DELETE FROM people" }
        }),
    );
    send(&mut stdin, line).await;
    let resp = recv(&mut stdout, id).await;
    assert_eq!(resp["result"]["isError"], true, "{resp}");
    let msg = resp["result"]["content"][0]["text"].as_str().unwrap_or("");
    assert!(msg.contains("read-only"), "{msg}");

    // resources
    let (id, line) = call("resources/list", json!({}));
    send(&mut stdin, line).await;
    let resp = recv(&mut stdout, id).await;
    assert_eq!(resp["result"]["resources"][0]["uri"], "plinth://connections");

    let (id, line) = call(
        "resources/read",
        json!({ "uri": format!("plinth://{}/schema/-/people", fx.connection_id) }),
    );
    send(&mut stdin, line).await;
    let resp = recv(&mut stdout, id).await;
    let text = resp["result"]["contents"][0]["text"].as_str().unwrap_or("");
    let schema: Value = serde_json::from_str(text).expect("schema json");
    assert_eq!(schema["primaryKey"][0], "id");

    // AI activity landed in the shared console
    drop(stdin);
    let _ = tokio::time::timeout(Duration::from_secs(10), child.wait()).await;
    let engine = Engine::new(
        fx.data_dir.clone(),
        Arc::new(InMemorySecrets::new()),
        Arc::new(SqlxFactory),
    )
    .await
    .expect("engine");
    let console = engine.console_list(None, 100).await.expect("console");
    assert!(
        console
            .iter()
            .any(|e| e.source == ConsoleSource::Ai && e.sql.contains("FROM people")),
        "expected an AI console entry, got {console:?}"
    );
    engine.shutdown().await;
}

#[tokio::test]
async fn tool_bodies_in_process() {
    let fx = seed("inproc").await;
    let engine = Engine::new(
        fx.data_dir.clone(),
        Arc::new(InMemorySecrets::new()),
        Arc::new(SqlxFactory),
    )
    .await
    .expect("engine");
    let mcp = PlinthMcp::new(engine.clone());
    let cid = fx.connection_id.as_str();

    // list_tables / describe_table / search_schema / sample_rows
    let tables = mcp.do_list_tables(cid, None).await.expect("list_tables");
    let names: Vec<&str> = tables
        .as_array()
        .expect("array")
        .iter()
        .filter_map(|t| t["name"].as_str())
        .collect();
    assert!(names.contains(&"people") && names.contains(&"orders"), "{names:?}");

    let desc = mcp
        .do_describe_table(cid, "orders".into(), None)
        .await
        .expect("describe");
    assert_eq!(desc["foreignKeys"][0]["refTable"]["name"], "people");

    let hits = mcp.do_search_schema(cid, "peop").await.expect("search");
    assert_eq!(hits[0]["kind"], "table");
    assert_eq!(hits[0]["table"], "people");
    let hits = mcp.do_search_schema(cid, "age").await.expect("search");
    assert!(hits
        .as_array()
        .expect("array")
        .iter()
        .any(|h| h["column"] == "age"));

    let sample = mcp
        .do_sample_rows(cid, "people".into(), None, Some(1))
        .await
        .expect("sample");
    assert_eq!(sample["rowCount"], 1);

    // guardrails
    let err = mcp
        .do_run_query(cid, "SELECT 1; SELECT 2".into(), None)
        .await
        .expect_err("two statements");
    assert!(err.0.contains("exactly one statement"), "{}", err.0);

    let err = mcp
        .do_run_query(cid, "UPDATE people SET age = 1 WHERE id = 1".into(), None)
        .await
        .expect_err("write");
    assert!(err.0.contains("read-only"), "{}", err.0);

    let err = mcp
        .do_run_query("nope", "SELECT 1".into(), None)
        .await
        .expect_err("unknown connection");
    assert!(err.0.contains("list_connections"), "{}", err.0);

    // output budget: a wide result gets truncated under 100 KB
    let wide = mcp
        .do_run_query(
            cid,
            "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 1000) \
             SELECT x, hex(randomblob(200)) AS blob FROM n"
                .into(),
            Some(1000),
        )
        .await
        .expect("wide");
    assert_eq!(wide["truncated"], true);
    assert!(serde_json::to_string(&wide).expect("json").len() <= plinth_mcp::server::OUTPUT_BUDGET);
    assert!(wide["rowCount"].as_u64().unwrap_or(0) > 100);

    engine.shutdown().await;
}
