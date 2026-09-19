//! Local-AI setup for the inspector's AI tab: what this machine can actually
//! run (Ollama), which models fit in its memory, and wiring the bundled MCP
//! server into the MCP clients installed here.
//!
//! Shell-only, like `sqlite_pick_file` — none of this touches the engine
//! contract in `crates/core/src/ipc.rs`. The mirror of these types lives in
//! `src/ipc/types.ts`.
//!
//! The Ollama probe speaks HTTP over a plain `TcpStream` rather than pulling
//! in an HTTP client: two small GETs to a loopback port, with a short timeout
//! so a dead port never stalls the pane.

use parking_lot::Mutex;
use plinth_core::IpcError;
use serde::Serialize;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::Duration;

const OLLAMA_ADDR: &str = "127.0.0.1:11434";
const PROBE_TIMEOUT: Duration = Duration::from_millis(700);
const START_WAIT: Duration = Duration::from_secs(8);
/// Generation on a laptop CPU/GPU is slow; give it room before giving up.
const ASK_TIMEOUT: Duration = Duration::from_secs(180);

// ───────────────────────── state ─────────────────────────

/// A model pull runs in its own thread; the pane polls `ai_probe` for it.
#[derive(Default)]
pub struct AiState {
    pull: Mutex<Option<PullState>>,
}

pub type Ai<'a> = tauri::State<'a, Arc<AiState>>;

// ───────────────────────── wire types ─────────────────────────

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullState {
    pub model: String,
    pub done: bool,
    pub ok: bool,
    pub message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareInfo {
    pub os: String,
    pub arch: String,
    pub chip: String,
    pub cpu_cores: u32,
    pub memory_gb: f64,
    pub unified_memory: bool,
    /// Memory we're willing to promise a model — macOS hands the GPU ~75% of
    /// unified memory by default; elsewhere we leave 4 GB for the OS.
    pub usable_model_gb: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaModel {
    pub name: String,
    pub size_gb: f64,
    pub parameter_size: Option<String>,
    pub quantization: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaInfo {
    pub installed: bool,
    pub running: bool,
    pub version: Option<String>,
    pub endpoint: String,
    pub binary_path: Option<String>,
    pub models: Vec<OllamaModel>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelOption {
    pub name: String,
    pub label: String,
    pub params_b: f64,
    pub download_gb: f64,
    pub needs_gb: f64,
    pub fits: bool,
    pub installed: bool,
    pub note: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpClientInfo {
    pub id: String,
    pub name: String,
    pub config_path: Option<String>,
    pub available: bool,
    pub registered: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpInfo {
    pub built: bool,
    pub binary_path: Option<String>,
    pub buildable: bool,
    pub clients: Vec<McpClientInfo>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStatus {
    pub hardware: HardwareInfo,
    pub ollama: OllamaInfo,
    pub mcp: McpInfo,
    pub models: Vec<ModelOption>,
    pub pulling: Option<PullState>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiActionResult {
    pub ok: bool,
    pub message: String,
}

impl AiActionResult {
    fn ok(message: impl Into<String>) -> Self {
        Self { ok: true, message: message.into() }
    }
    fn fail(message: impl Into<String>) -> Self {
        Self { ok: false, message: message.into() }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiAnswer {
    pub text: String,
    /// One statement, or `None` when the question wasn't asking for data.
    pub sql: Option<String>,
    /// Tables the answer leans on, as `schema.table`, for the chips.
    pub tables: Vec<String>,
    pub duration_ms: u64,
}

// ───────────────────────── loopback HTTP ─────────────────────────

/// `GET` a small JSON body from the Ollama daemon. `None` means "not there" —
/// a closed port, a timeout, or a reply we couldn't parse.
fn ollama_get(path: &str) -> Option<serde_json::Value> {
    let addr: SocketAddr = OLLAMA_ADDR.parse().ok()?;
    let mut sock = TcpStream::connect_timeout(&addr, PROBE_TIMEOUT).ok()?;
    sock.set_read_timeout(Some(PROBE_TIMEOUT)).ok()?;
    sock.set_write_timeout(Some(PROBE_TIMEOUT)).ok()?;
    let req = format!(
        "GET {path} HTTP/1.1\r\nHost: {OLLAMA_ADDR}\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
    );
    sock.write_all(req.as_bytes()).ok()?;
    let mut raw = Vec::new();
    // A read timeout still leaves whatever already arrived in `raw`.
    let _ = sock.read_to_end(&mut raw);
    let text = String::from_utf8_lossy(&raw);
    let (head, body) = text.split_once("\r\n\r\n")?;
    let body = if head.to_ascii_lowercase().contains("transfer-encoding: chunked") {
        dechunk(body)
    } else {
        body.to_string()
    };
    serde_json::from_str(&body).ok()
}

/// Minimal `Transfer-Encoding: chunked` reassembly — enough for Ollama's
/// small replies, which arrive in one or two chunks.
fn dechunk(body: &str) -> String {
    let mut out = String::new();
    let mut rest = body;
    while let Some((size_line, tail)) = rest.split_once("\r\n") {
        let hex = size_line.split(';').next().unwrap_or("").trim();
        let Ok(size) = usize::from_str_radix(hex, 16) else { break };
        if size == 0 {
            break;
        }
        // `get` rather than a slice: a chunk boundary mid-codepoint would panic.
        let Some(chunk) = tail.get(..size) else { break };
        out.push_str(chunk);
        rest = tail[size..].strip_prefix("\r\n").unwrap_or("");
    }
    out
}

fn ollama_running() -> bool {
    OLLAMA_ADDR
        .parse::<SocketAddr>()
        .ok()
        .and_then(|a| TcpStream::connect_timeout(&a, PROBE_TIMEOUT).ok())
        .is_some()
}

/// `POST` a JSON body and read the whole (non-streamed) reply. `Err` carries
/// something worth showing the user — this one is on a button press.
fn ollama_post(path: &str, body: &serde_json::Value, timeout: Duration) -> Result<serde_json::Value, String> {
    let addr: SocketAddr = OLLAMA_ADDR.parse().map_err(|e| format!("{e}"))?;
    let mut sock = TcpStream::connect_timeout(&addr, PROBE_TIMEOUT)
        .map_err(|_| format!("Ollama isn't answering on {OLLAMA_ADDR}."))?;
    let _ = sock.set_read_timeout(Some(timeout));
    let _ = sock.set_write_timeout(Some(PROBE_TIMEOUT));
    let payload = serde_json::to_vec(body).map_err(|e| e.to_string())?;
    let head = format!(
        "POST {path} HTTP/1.1\r\nHost: {OLLAMA_ADDR}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        payload.len()
    );
    sock.write_all(head.as_bytes())
        .and_then(|_| sock.write_all(&payload))
        .map_err(|e| format!("Couldn't send the prompt: {e}"))?;

    let mut raw = Vec::new();
    sock.read_to_end(&mut raw)
        .map_err(|_| format!("Ollama went quiet after {}s.", timeout.as_secs()))?;
    let text = String::from_utf8_lossy(&raw);
    let (head, body) = text.split_once("\r\n\r\n").ok_or("Malformed reply from Ollama.")?;
    let status = head.lines().next().unwrap_or_default();
    if !status.contains(" 200") {
        return Err(format!("Ollama replied {}", status.trim_start_matches("HTTP/1.1 ").trim()));
    }
    let body = if head.to_ascii_lowercase().contains("transfer-encoding: chunked") {
        dechunk(body)
    } else {
        body.to_string()
    };
    serde_json::from_str(&body).map_err(|e| format!("Unreadable reply from Ollama: {e}"))
}

// ───────────────────────── machine ─────────────────────────

fn first_line(out: std::process::Output) -> Option<String> {
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
}

fn run(bin: &str, args: &[&str]) -> Option<String> {
    first_line(Command::new(bin).args(args).output().ok()?)
}

fn hardware() -> HardwareInfo {
    let os = std::env::consts::OS.to_string();
    let arch = std::env::consts::ARCH.to_string();
    let unified = os == "macos" && arch == "aarch64";

    let (chip, cores, bytes) = if os == "macos" {
        (
            run("sysctl", &["-n", "machdep.cpu.brand_string"]).unwrap_or_else(|| "Unknown CPU".into()),
            run("sysctl", &["-n", "hw.ncpu"]).and_then(|s| s.parse().ok()).unwrap_or(0),
            run("sysctl", &["-n", "hw.memsize"]).and_then(|s| s.parse::<u64>().ok()).unwrap_or(0),
        )
    } else {
        let cpuinfo = std::fs::read_to_string("/proc/cpuinfo").unwrap_or_default();
        let chip = cpuinfo
            .lines()
            .find(|l| l.starts_with("model name"))
            .and_then(|l| l.split_once(':'))
            .map(|(_, v)| v.trim().to_string())
            .unwrap_or_else(|| "Unknown CPU".into());
        let cores = cpuinfo.lines().filter(|l| l.starts_with("processor")).count() as u32;
        let kb = std::fs::read_to_string("/proc/meminfo")
            .ok()
            .and_then(|m| {
                m.lines()
                    .find(|l| l.starts_with("MemTotal"))?
                    .split_whitespace()
                    .nth(1)?
                    .parse::<u64>()
                    .ok()
            })
            .unwrap_or(0);
        (chip, cores, kb * 1024)
    };

    let memory_gb = bytes as f64 / 1_073_741_824.0;
    let usable = if memory_gb <= 0.0 {
        0.0
    } else if unified {
        memory_gb * 0.75
    } else {
        (memory_gb - 4.0).max(0.0)
    };

    HardwareInfo {
        os,
        arch,
        chip,
        cpu_cores: cores,
        memory_gb: (memory_gb * 10.0).round() / 10.0,
        unified_memory: unified,
        usable_model_gb: (usable * 10.0).round() / 10.0,
    }
}

// ───────────────────────── ollama ─────────────────────────

fn ollama_binary() -> Option<PathBuf> {
    if let Some(p) = run("which", &["ollama"]) {
        return Some(PathBuf::from(p));
    }
    ["/opt/homebrew/bin/ollama", "/usr/local/bin/ollama", "/usr/bin/ollama", "/Applications/Ollama.app/Contents/Resources/ollama"]
        .into_iter()
        .map(PathBuf::from)
        .find(|p| p.exists())
}

fn ollama_info() -> OllamaInfo {
    let binary = ollama_binary();
    let running = ollama_running();
    let version = running
        .then(|| ollama_get("/api/version"))
        .flatten()
        .and_then(|v| v.get("version")?.as_str().map(str::to_string));

    let mut models = Vec::new();
    if running {
        if let Some(tags) = ollama_get("/api/tags") {
            for m in tags.get("models").and_then(|m| m.as_array()).into_iter().flatten() {
                let Some(name) = m.get("name").and_then(|n| n.as_str()) else { continue };
                let bytes = m.get("size").and_then(|s| s.as_f64()).unwrap_or(0.0);
                let details = m.get("details");
                models.push(OllamaModel {
                    name: name.to_string(),
                    size_gb: (bytes / 1_073_741_824.0 * 10.0).round() / 10.0,
                    parameter_size: details
                        .and_then(|d| d.get("parameter_size"))
                        .and_then(|v| v.as_str())
                        .map(str::to_string),
                    quantization: details
                        .and_then(|d| d.get("quantization_level"))
                        .and_then(|v| v.as_str())
                        .map(str::to_string),
                });
            }
        }
        models.sort_by(|a, b| a.name.cmp(&b.name));
    }

    OllamaInfo {
        installed: binary.is_some() || running,
        running,
        version,
        endpoint: format!("http://{OLLAMA_ADDR}"),
        binary_path: binary.map(|p| p.to_string_lossy().into_owned()),
        models,
    }
}

/// Q4_K_M sizes, and the memory each wants with a working context. Sorted
/// biggest-first so the best model that fits is the first `fits` entry.
const CATALOG: &[(&str, &str, f64, f64, f64, &str)] = &[
    ("llama3.3:70b", "Llama 3.3 70B", 70.0, 43.0, 50.0, "Only on a 64 GB+ machine"),
    ("qwen2.5-coder:32b", "Qwen2.5 Coder 32B", 32.0, 20.0, 26.0, "Strongest SQL that runs locally"),
    ("qwen2.5-coder:14b", "Qwen2.5 Coder 14B", 14.0, 9.0, 13.0, "Strong SQL, comfortable on 24 GB"),
    ("llama3.1:8b", "Llama 3.1 8B", 8.0, 4.9, 9.0, "General purpose"),
    ("qwen2.5-coder:7b", "Qwen2.5 Coder 7B", 7.0, 4.7, 8.0, "Best small SQL writer"),
    ("llama3.2:3b", "Llama 3.2 3B", 3.0, 2.0, 4.0, "Quick summaries and column guesses"),
    ("llama3.2:1b", "Llama 3.2 1B", 1.0, 1.3, 2.0, "Fastest; very limited"),
];

fn model_options(hw: &HardwareInfo, installed: &[OllamaModel]) -> Vec<ModelOption> {
    let budget = hw.usable_model_gb;
    let mut out: Vec<ModelOption> = CATALOG
        .iter()
        .map(|(name, label, params, download, needs, note)| ModelOption {
            name: (*name).to_string(),
            label: (*label).to_string(),
            params_b: *params,
            download_gb: *download,
            needs_gb: *needs,
            fits: budget >= *needs,
            installed: installed.iter().any(|m| m.name == *name || m.name == format!("{name}:latest")),
            note: (*note).to_string(),
        })
        .collect();

    // Anything already pulled is runnable by definition — list it even when
    // it isn't in the catalogue, so the dropdown matches `ollama list`.
    for m in installed {
        if out.iter().any(|o| o.name == m.name || format!("{}:latest", o.name) == m.name) {
            continue;
        }
        out.push(ModelOption {
            name: m.name.clone(),
            label: m.name.clone(),
            params_b: 0.0,
            download_gb: m.size_gb,
            needs_gb: m.size_gb + 1.0,
            fits: budget >= m.size_gb + 1.0,
            installed: true,
            note: match (&m.parameter_size, &m.quantization) {
                (Some(p), Some(q)) => format!("Already pulled · {p} · {q}"),
                _ => "Already pulled".into(),
            },
        });
    }
    out
}

// ───────────────────────── mcp ─────────────────────────

/// The repo this dev build was launched from, if it is still a repo — used to
/// offer `cargo build -p plinth-mcp` when the binary hasn't been built yet.
fn repo_root() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let mut dir = exe.parent()?.to_path_buf();
    loop {
        if dir.join("crates/mcp/Cargo.toml").exists() {
            return Some(dir);
        }
        if !dir.pop() {
            return None;
        }
    }
}

fn mcp_binary() -> Option<PathBuf> {
    // Next to the app binary first: that's how a bundle would ship it.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let sibling = dir.join("plinth-mcp");
            if sibling.exists() {
                return Some(sibling);
            }
        }
    }
    if let Some(root) = repo_root() {
        for profile in ["release", "debug"] {
            let p = root.join("target").join(profile).join("plinth-mcp");
            if p.exists() {
                return Some(p);
            }
        }
    }
    run("which", &["plinth-mcp"]).map(PathBuf::from)
}

fn claude_desktop_config() -> Option<PathBuf> {
    let home = dirs_home()?;
    Some(match std::env::consts::OS {
        "macos" => home.join("Library/Application Support/Claude/claude_desktop_config.json"),
        "windows" => home.join("AppData/Roaming/Claude/claude_desktop_config.json"),
        _ => home.join(".config/Claude/claude_desktop_config.json"),
    })
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn json_has_plinth(path: &Path) -> bool {
    let Ok(text) = std::fs::read_to_string(path) else { return false };
    serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|v| Some(v.get("mcpServers")?.get("plinth").is_some()))
        .unwrap_or(false)
}

fn mcp_info() -> McpInfo {
    let binary = mcp_binary();
    let desktop = claude_desktop_config();
    let desktop_available = desktop
        .as_ref()
        .and_then(|p| p.parent().map(Path::exists))
        .unwrap_or(false);
    let code_config = dirs_home().map(|h| h.join(".claude.json"));

    let clients = vec![
        McpClientInfo {
            id: "claude-desktop".into(),
            name: "Claude Desktop".into(),
            config_path: desktop.as_ref().map(|p| p.to_string_lossy().into_owned()),
            available: desktop_available,
            registered: desktop.as_deref().map(json_has_plinth).unwrap_or(false),
        },
        McpClientInfo {
            id: "claude-code".into(),
            name: "Claude Code".into(),
            config_path: code_config.as_ref().map(|p| p.to_string_lossy().into_owned()),
            available: run("which", &["claude"]).is_some(),
            registered: code_config.as_deref().map(json_has_plinth).unwrap_or(false),
        },
    ];

    McpInfo {
        built: binary.is_some(),
        binary_path: binary.map(|p| p.to_string_lossy().into_owned()),
        buildable: repo_root().is_some(),
        clients,
    }
}

/// Build `plinth-mcp` in release, returning its path. Cold, this is minutes.
fn build_mcp() -> Result<PathBuf, String> {
    let root = repo_root().ok_or("No Plinth source tree next to this build — build plinth-mcp yourself and put it on PATH.")?;
    let out = Command::new("cargo")
        .args(["build", "--release", "-p", "plinth-mcp"])
        .current_dir(&root)
        .output()
        .map_err(|e| format!("cargo not found: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let tail: Vec<&str> = err.lines().rev().take(4).collect();
        return Err(format!("cargo build failed: {}", tail.into_iter().rev().collect::<Vec<_>>().join(" / ")));
    }
    mcp_binary().ok_or_else(|| "Build reported success but the binary isn't where we expected.".into())
}

fn register_claude_desktop(binary: &Path) -> Result<String, String> {
    let path = claude_desktop_config().ok_or("No home directory")?;
    let mut root: serde_json::Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    if !root.is_object() {
        return Err(format!("{} isn't a JSON object — left alone.", path.display()));
    }
    let servers = root
        .as_object_mut()
        .unwrap()
        .entry("mcpServers")
        .or_insert_with(|| serde_json::json!({}));
    if !servers.is_object() {
        return Err("`mcpServers` isn't a JSON object — left alone.".into());
    }
    servers.as_object_mut().unwrap().insert(
        "plinth".into(),
        serde_json::json!({ "command": binary.to_string_lossy() }),
    );
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| e.to_string())?;
    Ok(format!("Added to {}. Restart Claude Desktop to pick it up.", path.display()))
}

fn register_claude_code(binary: &Path) -> Result<String, String> {
    if run("which", &["claude"]).is_none() {
        return Err("The `claude` CLI isn't on PATH — install Claude Code first.".into());
    }
    let out = Command::new("claude")
        .args(["mcp", "add", "plinth", "-s", "user", "--", &binary.to_string_lossy()])
        .output()
        .map_err(|e| format!("claude mcp add failed to start: {e}"))?;
    if out.status.success() {
        Ok("Registered with Claude Code (user scope).".into())
    } else {
        let err = String::from_utf8_lossy(&out.stderr);
        Err(format!("claude mcp add: {}", err.trim().lines().next().unwrap_or("failed")))
    }
}

fn open_url(url: &str) {
    let (bin, args): (&str, Vec<&str>) = match std::env::consts::OS {
        "macos" => ("open", vec![url]),
        "windows" => ("cmd", vec!["/C", "start", url]),
        _ => ("xdg-open", vec![url]),
    };
    let _ = Command::new(bin).args(args).stdout(Stdio::null()).stderr(Stdio::null()).spawn();
}

// ───────────────────────── commands ─────────────────────────

/// Everything the AI tab needs in one round trip: the machine, Ollama, the
/// models that fit, and how the MCP server is wired up.
#[tauri::command]
pub async fn ai_probe(ai: Ai<'_>) -> Result<AiStatus, IpcError> {
    let pulling = ai.pull.lock().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let hardware = hardware();
        let ollama = ollama_info();
        let models = model_options(&hardware, &ollama.models);
        AiStatus { hardware, ollama, mcp: mcp_info(), models, pulling }
    })
    .await
    .map_err(IpcError::internal)
}

/// Install Ollama with Homebrew when it's there, otherwise open the download
/// page — we never download and run an installer behind the user's back.
#[tauri::command]
pub async fn ai_ollama_install() -> Result<AiActionResult, IpcError> {
    tauri::async_runtime::spawn_blocking(|| {
        if ollama_binary().is_some() {
            return AiActionResult::ok("Ollama is already installed.");
        }
        let Some(brew) = run("which", &["brew"]) else {
            open_url("https://ollama.com/download");
            return AiActionResult::ok("Opened ollama.com/download — Homebrew isn't installed here.");
        };
        let out = Command::new(brew).args(["install", "ollama"]).output();
        match out {
            Ok(o) if o.status.success() => AiActionResult::ok("Installed with Homebrew. Start it below."),
            Ok(o) => {
                let err = String::from_utf8_lossy(&o.stderr);
                AiActionResult::fail(format!("brew install ollama: {}", err.trim().lines().last().unwrap_or("failed")))
            }
            Err(e) => AiActionResult::fail(format!("brew install ollama: {e}")),
        }
    })
    .await
    .map_err(IpcError::internal)
}

/// `ollama serve` in the background, then wait for the port to answer.
#[tauri::command]
pub async fn ai_ollama_start() -> Result<AiActionResult, IpcError> {
    tauri::async_runtime::spawn_blocking(|| {
        if ollama_running() {
            return AiActionResult::ok("Ollama is already running.");
        }
        let Some(bin) = ollama_binary() else {
            return AiActionResult::fail("Ollama isn't installed on this machine.");
        };
        if let Err(e) = Command::new(&bin).arg("serve").stdout(Stdio::null()).stderr(Stdio::null()).spawn() {
            return AiActionResult::fail(format!("Couldn't start ollama serve: {e}"));
        }
        let deadline = std::time::Instant::now() + START_WAIT;
        while std::time::Instant::now() < deadline {
            if ollama_running() {
                return AiActionResult::ok("Ollama is running.");
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        AiActionResult::fail("Started ollama serve but the port never answered.")
    })
    .await
    .map_err(IpcError::internal)
}

/// Kick off `ollama pull` and return immediately — a pull is gigabytes. The
/// pane polls `ai_probe` and watches `pulling`.
#[tauri::command]
pub async fn ai_model_pull(ai: Ai<'_>, model: String) -> Result<AiActionResult, IpcError> {
    if model.trim().is_empty() {
        return Err(IpcError::invalid("No model selected"));
    }
    {
        let mut slot = ai.pull.lock();
        if let Some(p) = slot.as_ref() {
            if !p.done {
                return Ok(AiActionResult::fail(format!("Already pulling {}.", p.model)));
            }
        }
        *slot = Some(PullState { model: model.clone(), done: false, ok: false, message: "Downloading…".into() });
    }

    let Some(bin) = ollama_binary() else {
        *ai.pull.lock() = None;
        return Ok(AiActionResult::fail("Ollama isn't installed on this machine."));
    };
    let state = Arc::clone(ai.inner());
    let pulling = model.clone();
    std::thread::spawn(move || {
        let model = pulling;
        let out = Command::new(bin).arg("pull").arg(&model).output();
        let result = match out {
            Ok(o) if o.status.success() => PullState { model, done: true, ok: true, message: "Ready.".into() },
            Ok(o) => {
                let err = String::from_utf8_lossy(&o.stderr);
                PullState { model, done: true, ok: false, message: err.trim().lines().last().unwrap_or("pull failed").to_string() }
            }
            Err(e) => PullState { model, done: true, ok: false, message: format!("ollama pull: {e}") },
        };
        *state.pull.lock() = Some(result);
    });
    Ok(AiActionResult::ok(format!("Pulling {model} — this can take a few minutes.")))
}

/// Point an MCP client at `plinth-mcp`, building it first when this is a dev
/// tree and the binary isn't there yet.
#[tauri::command]
pub async fn ai_mcp_connect(client: String) -> Result<AiActionResult, IpcError> {
    tauri::async_runtime::spawn_blocking(move || {
        let binary = match mcp_binary() {
            Some(p) => p,
            None => match build_mcp() {
                Ok(p) => p,
                Err(e) => return AiActionResult::fail(e),
            },
        };
        let registered = match client.as_str() {
            "claude-desktop" => register_claude_desktop(&binary),
            "claude-code" => register_claude_code(&binary),
            other => Err(format!("Unknown MCP client “{other}”.")),
        };
        match registered {
            Ok(m) => AiActionResult::ok(m),
            Err(e) => AiActionResult::fail(e),
        }
    })
    .await
    .map_err(IpcError::internal)
}

/// Kept deliberately narrow: the model reads the schema and writes SQL, it
/// never runs anything. Execution stays in the editor, under the policy engine.
const ASK_SYSTEM: &str = "You are a helpful assistant inside Plinth, a database client. Reply as \
JSON with three fields. `answer` is what you would say out loud: talk normally, a greeting gets a \
short friendly reply, a question about the schema gets plain sentences, and never put SQL in it. \
`sql` is exactly one statement when the person is asking for data, and null otherwise — never two \
statements, never a query nobody asked for. `tables` lists the tables the answer uses, as \
schema.table. Use only the tables and columns in the schema you are given; never invent one. Where a \
column's meaning is unclear, assume the obvious thing and say so briefly rather than refusing. You \
cannot run queries yourself, so never state a count, a total or any other result as if you had seen \
it — describe what the query will return instead. The person presses Run, and writes need their \
confirmation.";

/// The agent loop's vocabulary. One step per reply; the harness executes it
/// and hands back an observation. Read-only by construction: there is no step
/// that writes, so no prompt can talk the model into one.
const STEP_SYSTEM: &str = "You are a database analyst working one step at a time inside Plinth. Each \
reply is a single step. Think first, then choose an action:\n\
- \"inspect\": read a table's columns, types and keys. Set `table`.\n\
- \"sample\": look at five real rows, to learn what the values actually are. Set `table`.\n\
- \"probe\": run a read-only SELECT to check an assumption. Set `sql`. It is capped at five rows.\n\
- \"answer\": you are ready. Set `answer` (plain sentences explaining what the query does and why, \
including any assumption you made), `sql` (exactly one statement, or null if the question needs no \
query), `tables`, and `assumptions`.\n\
Prefer to sample a table before filtering on its values — never invent a status, category or enum. \
Never state a count or total as if you had seen it. Only the person runs anything that writes.";

/// Constraining the reply to this schema is what makes the SQL reliable —
/// before it, we were regexing ```sql fences out of prose and hoping.
fn step_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "thought": { "type": "string" },
            "action": { "type": "string", "enum": ["inspect", "sample", "probe", "answer"] },
            "table": { "type": ["string", "null"] },
            "sql": { "type": ["string", "null"] },
            "answer": { "type": ["string", "null"] },
            "tables": { "type": "array", "items": { "type": "string" } },
            "assumptions": { "type": "array", "items": { "type": "string" } },
        },
        "required": ["thought", "action"],
    })
}

fn answer_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "answer": { "type": "string" },
            "sql": { "type": ["string", "null"] },
            "tables": { "type": "array", "items": { "type": "string" } },
        },
        "required": ["answer"],
    })
}

/// One turn of the conversation in the AI tab. `history` carries the earlier
/// turns so a follow-up ("now group it by month") isn't a cold start.
#[derive(Clone, serde::Deserialize)]
pub struct ChatTurn {
    pub role: String,
    pub content: String,
}

/// Ask the selected local model about the open database. Blocking and
/// non-streamed — one prompt, one answer.
#[tauri::command]
pub async fn ai_ask(
    model: String,
    prompt: String,
    context: String,
    history: Vec<ChatTurn>,
) -> Result<AiAnswer, IpcError> {
    if prompt.trim().is_empty() {
        return Err(IpcError::invalid("Empty prompt"));
    }
    if model.trim().is_empty() {
        return Err(IpcError::invalid("No local model selected"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let system = if context.trim().is_empty() {
            ASK_SYSTEM.to_string()
        } else {
            format!("{ASK_SYSTEM}\n\nSchema of the open database:\n{context}")
        };
        let mut messages = vec![serde_json::json!({ "role": "system", "content": system })];
        // Last few turns only: a small model's context is the scarce resource.
        for turn in history.iter().rev().take(6).rev() {
            let role = if turn.role == "assistant" { "assistant" } else { "user" };
            messages.push(serde_json::json!({ "role": role, "content": turn.content }));
        }
        messages.push(serde_json::json!({ "role": "user", "content": prompt }));
        let body = serde_json::json!({
            "model": model,
            "stream": false,
            "format": answer_schema(),
            "options": { "temperature": 0.2 },
            "messages": messages,
        });
        let started = std::time::Instant::now();
        let reply = ollama_post("/api/chat", &body, ASK_TIMEOUT).map_err(IpcError::driver)?;
        let content = reply
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_str())
            .unwrap_or_default()
            .trim()
            .to_string();
        if content.is_empty() {
            return Err(IpcError::driver("The model returned nothing."));
        }
        let duration_ms = started.elapsed().as_millis() as u64;
        // A model that ignores the schema, or an older daemon that ignores
        // `format`, still gets its prose through rather than erroring.
        Ok(match serde_json::from_str::<serde_json::Value>(&content) {
            Ok(v) if v.is_object() => AiAnswer {
                text: v.get("answer").and_then(|a| a.as_str()).unwrap_or(&content).trim().to_string(),
                sql: v.get("sql").and_then(|q| q.as_str()).map(str::trim).filter(|q| !q.is_empty()).map(str::to_string),
                tables: v
                    .get("tables")
                    .and_then(|t| t.as_array())
                    .map(|a| a.iter().filter_map(|t| t.as_str().map(str::to_string)).collect())
                    .unwrap_or_default(),
                duration_ms,
            },
            _ => AiAnswer { text: content, sql: None, tables: Vec::new(), duration_ms },
        })
    })
    .await
    .map_err(IpcError::internal)?
}

/// One step of the agent loop. The harness owns the loop, the tools and the
/// budget; this is only "ask the model what to do next".
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStep {
    pub thought: String,
    pub action: String,
    pub table: Option<String>,
    pub sql: Option<String>,
    pub answer: Option<String>,
    pub tables: Vec<String>,
    pub assumptions: Vec<String>,
    pub duration_ms: u64,
}

#[tauri::command]
pub async fn ai_step(
    model: String,
    context: String,
    history: Vec<ChatTurn>,
) -> Result<AiStep, IpcError> {
    if model.trim().is_empty() {
        return Err(IpcError::invalid("No local model selected"));
    }
    if history.is_empty() {
        return Err(IpcError::invalid("Nothing to step on"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let system = if context.trim().is_empty() {
            STEP_SYSTEM.to_string()
        } else {
            format!("{STEP_SYSTEM}\n\nSchema of the open database:\n{context}")
        };
        let mut messages = vec![serde_json::json!({ "role": "system", "content": system })];
        for turn in history.iter() {
            let role = if turn.role == "assistant" { "assistant" } else { "user" };
            messages.push(serde_json::json!({ "role": role, "content": turn.content }));
        }
        let body = serde_json::json!({
            "model": model,
            "stream": false,
            "format": step_schema(),
            "options": { "temperature": 0.1 },
            "messages": messages,
        });
        let started = std::time::Instant::now();
        let reply = ollama_post("/api/chat", &body, ASK_TIMEOUT).map_err(IpcError::driver)?;
        let content = reply
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_str())
            .unwrap_or_default()
            .trim()
            .to_string();
        let v: serde_json::Value = serde_json::from_str(&content)
            .map_err(|e| IpcError::driver(format!("The model did not return a step ({e}): {content}")))?;
        let text = |k: &str| v.get(k).and_then(|x| x.as_str()).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
        let list = |k: &str| {
            v.get(k)
                .and_then(|x| x.as_array())
                .map(|a| a.iter().filter_map(|i| i.as_str().map(str::to_string)).collect())
                .unwrap_or_default()
        };
        // An unknown action is treated as an answer rather than an error: a
        // small model that goes off-script should still say something.
        let action = text("action").unwrap_or_else(|| "answer".into());
        let action = match action.as_str() {
            "inspect" | "sample" | "probe" | "answer" => action,
            _ => "answer".into(),
        };
        Ok(AiStep {
            thought: text("thought").unwrap_or_default(),
            action,
            table: text("table"),
            sql: text("sql"),
            answer: text("answer"),
            tables: list("tables"),
            assumptions: list("assumptions"),
            duration_ms: started.elapsed().as_millis() as u64,
        })
    })
    .await
    .map_err(IpcError::internal)?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Prints what this machine reports, the way the AI tab sees it. Ignored
    /// like the driver tests that need a live service:
    /// `cargo test -p plinth-app -- --ignored --nocapture`.
    #[test]
    #[ignore = "probes the local machine and the Ollama daemon"]
    fn probe_this_machine() {
        let hardware = hardware();
        let ollama = ollama_info();
        let models = model_options(&hardware, &ollama.models);
        let status = AiStatus { hardware, ollama, mcp: mcp_info(), models, pulling: None };
        println!("{}", serde_json::to_string_pretty(&status).unwrap());
    }

    /// Round-trips real prompts through whatever model is pulled here, with
    /// the same schema constraint the command uses: a greeting must come back
    /// as prose with no SQL, a data question with exactly one statement.
    /// `cargo test -p plinth-app --lib -- --ignored --nocapture`.
    #[test]
    #[ignore = "asks the local Ollama daemon for a completion"]
    fn ask_the_local_model() {
        let info = ollama_info();
        let Some(model) = info.models.first() else {
            eprintln!("no model pulled — skipping");
            return;
        };
        let system = format!(
            "{ASK_SYSTEM}\n\nSchema of the open database:\npublic.orders (table, ~2000 rows): id, customer_id, status, total, placed_at"
        );
        let ask = |question: &str| -> serde_json::Value {
            let body = serde_json::json!({
                "model": model.name,
                "stream": false,
                "format": answer_schema(),
                "options": { "temperature": 0.2 },
                "messages": [
                    { "role": "system", "content": system },
                    { "role": "user", "content": question },
                ],
            });
            let reply = ollama_post("/api/chat", &body, ASK_TIMEOUT).expect("ollama chat");
            let content = reply["message"]["content"].as_str().unwrap_or_default().to_string();
            serde_json::from_str(&content).unwrap_or_else(|e| panic!("not JSON ({e}): {content}"))
        };

        let greeting = ask("hey there");
        println!("--- {} · greeting ---\n{greeting:#}\n", model.name);
        assert!(!greeting["answer"].as_str().unwrap_or_default().trim().is_empty());
        assert!(greeting["sql"].as_str().unwrap_or_default().trim().is_empty(), "a greeting needs no SQL");

        let query = ask("how many refunded orders are there?");
        println!("--- {} · data question ---\n{query:#}", model.name);
        let sql = query["sql"].as_str().unwrap_or_default();
        assert!(sql.to_lowercase().contains("select"), "expected a SELECT, got: {sql}");
        assert!(sql.trim_end_matches(';').matches(';').count() == 0, "expected a single statement: {sql}");
    }

    /// The loop's first two turns against the real daemon: given the question
    /// that produced nonsense one-shot, the model should reach for the data
    /// before answering — and its answer must carry an explanation.
    #[test]
    #[ignore = "asks the local Ollama daemon for a completion"]
    fn agent_steps_reach_for_the_data() {
        let info = ollama_info();
        let Some(model) = info.models.first() else {
            eprintln!("no model pulled — skipping");
            return;
        };
        let context = "TABLE public.customers:\n  id bigint PRIMARY KEY\n  name text\n  email text\n\nTABLE public.orders:\n  id bigint PRIMARY KEY\n  customer_id bigint NOT NULL\n  status text\n  total numeric\n\nHow these tables join:\n  public.orders.customer_id = public.customers.id";
        let system = format!("{STEP_SYSTEM}\n\nSchema of the open database:\n{context}");
        let ask = |messages: Vec<serde_json::Value>| -> serde_json::Value {
            let mut msgs = vec![serde_json::json!({ "role": "system", "content": system })];
            msgs.extend(messages);
            let body = serde_json::json!({
                "model": model.name, "stream": false, "format": step_schema(),
                "options": { "temperature": 0.1 }, "messages": msgs,
            });
            let reply = ollama_post("/api/chat", &body, ASK_TIMEOUT).expect("ollama chat");
            let content = reply["message"]["content"].as_str().unwrap_or_default().to_string();
            serde_json::from_str(&content).unwrap_or_else(|e| panic!("not a step ({e}): {content}"))
        };

        let first = ask(vec![serde_json::json!({ "role": "user", "content": "which customer gives most orders" })]);
        println!("--- step 1 ---\n{first:#}\n");
        let action = first["action"].as_str().unwrap_or_default();
        assert!(["inspect", "sample", "probe", "answer"].contains(&action), "unknown action: {action}");
        assert!(!first["thought"].as_str().unwrap_or_default().trim().is_empty(), "a step must say why");

        // Feed an observation back and make sure it keeps to the protocol.
        let second = ask(vec![
            serde_json::json!({ "role": "user", "content": "which customer gives most orders" }),
            serde_json::json!({ "role": "assistant", "content": first.to_string() }),
            serde_json::json!({ "role": "user", "content": "Observation: public.orders has 2000 rows; sample customer_id values: 12, 40, 7, 12, 3. public.customers.name values: 'Customer 12', 'Customer 40'." }),
        ]);
        println!("--- step 2 ---\n{second:#}");
        assert!(["inspect", "sample", "probe", "answer"].contains(&second["action"].as_str().unwrap_or_default()));
    }

    #[test]
    fn dechunk_reassembles_a_split_body() {
        assert_eq!(dechunk("5\r\n{\"a\":\r\n2\r\n1}\r\n0\r\n\r\n"), "{\"a\":1}");
    }

    /// A machine with no memory reading must not advertise a budget.
    #[test]
    fn no_memory_means_no_budget() {
        let hw = HardwareInfo {
            os: "linux".into(),
            arch: "x86_64".into(),
            chip: "Unknown CPU".into(),
            cpu_cores: 0,
            memory_gb: 0.0,
            unified_memory: false,
            usable_model_gb: 0.0,
        };
        assert!(model_options(&hw, &[]).iter().all(|m| !m.fits));
    }
}
