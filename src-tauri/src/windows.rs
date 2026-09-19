//! Windows.
//!
//! One process, one engine, many windows — the shape every native database
//! client has. A window owns a connection and its tabs; the connections, the
//! console, the saved queries and the AI are the application's, not the
//! window's, because they are the same in all of them.
//!
//! The chrome is built here rather than in `tauri.conf.json` so that a window
//! opened at runtime is indistinguishable from the one the config creates:
//! same size, same overlay title bar, same traffic-light inset, same
//! vibrancy. A second window that looks subtly different is a bug people
//! notice immediately and cannot name.

use plinth_core::IpcError;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// Matches `app.windows[0]` in `tauri.conf.json`. Kept in step by hand.
const WIDTH: f64 = 1180.0;
const HEIGHT: f64 = 760.0;
const MIN_WIDTH: f64 = 900.0;
const MIN_HEIGHT: f64 = 560.0;
/// Enough that the window beneath stays grabbable, small enough to feel stacked.
const CASCADE: f64 = 28.0;

fn next_label(app: &AppHandle) -> String {
    let taken = app.webview_windows();
    (1..)
        .map(|n| format!("w{n}"))
        .find(|l| !taken.contains_key(l))
        .unwrap_or_else(|| "w".to_string())
}

/// Percent-encode a query value. A database name can contain anything; this
/// is three lines against a dependency, so it is three lines.
fn q(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for b in value.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Where to put it: down-and-right of the window that asked, the way every
/// document app cascades. Falls back to the platform default.
fn cascade_from(app: &AppHandle, from: Option<&str>) -> Option<tauri::LogicalPosition<f64>> {
    let w = from.and_then(|l| app.get_webview_window(l))?;
    let pos = w.outer_position().ok()?;
    let scale = w.scale_factor().unwrap_or(1.0);
    let logical = pos.to_logical::<f64>(scale);
    Some(tauri::LogicalPosition::new(
        logical.x + CASCADE,
        logical.y + CASCADE,
    ))
}

/// Open a window. `open`/`database` are carried in the URL so the new window
/// connects on its own rather than being told to afterwards — there is no
/// moment where it is showing the wrong thing.
#[tauri::command]
pub async fn window_open(
    app: AppHandle,
    open: Option<String>,
    database: Option<String>,
    from: Option<String>,
) -> Result<String, IpcError> {
    let label = next_label(&app);
    let mut url = String::from("index.html");
    if let Some(conn) = open.as_deref() {
        url.push_str(&format!("?open={}", q(conn)));
        if let Some(db) = database.as_deref() {
            url.push_str(&format!("&db={}", q(db)));
        }
    }

    let mut b = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
        .title("Plinth")
        .inner_size(WIDTH, HEIGHT)
        .min_inner_size(MIN_WIDTH, MIN_HEIGHT)
        .transparent(true);

    #[cfg(target_os = "macos")]
    {
        b = b
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            .traffic_light_position(tauri::LogicalPosition::new(16.0, 18.0))
            .tabbing_identifier("plinth-workspace");
    }

    if let Some(p) = cascade_from(&app, from.as_deref()) {
        b = b.position(p.x, p.y);
    }

    let window = b
        .build()
        .map_err(|e| IpcError::internal(format!("Could not open a window: {e}")))?;

    #[cfg(target_os = "macos")]
    {
        use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};
        if let Err(e) = apply_vibrancy(&window, NSVisualEffectMaterial::Sidebar, None, None) {
            tracing::warn!(error = %e, "vibrancy unavailable on new window");
        }
    }

    tracing::info!(label = %label, "window opened");
    Ok(window.label().to_string())
}

/// Bring an existing window forward — what "this connection is already open"
/// should do instead of opening it twice.
#[tauri::command]
pub async fn window_focus(app: AppHandle, label: String) -> Result<bool, IpcError> {
    match app.get_webview_window(&label) {
        Some(w) => {
            let _ = w.unminimize();
            let _ = w.set_focus();
            Ok(true)
        }
        None => Ok(false),
    }
}

/// Every window this process currently has open, so the UI can tell a stale
/// registry entry from a live one.
#[tauri::command]
pub async fn window_list(app: AppHandle) -> Result<Vec<String>, IpcError> {
    Ok(app.webview_windows().keys().cloned().collect())
}

#[cfg(test)]
mod tests {
    use super::q;

    #[test]
    fn query_values_survive_the_url() {
        // The common case is untouched — a label stays readable in the URL.
        assert_eq!(q("c_staging"), "c_staging");
        assert_eq!(q("plinth_demo"), "plinth_demo");
        // Anything that would end the value, start another parameter, or be
        // read as a fragment has to be encoded, or the window opens on the
        // wrong database.
        assert_eq!(q("a&b=c"), "a%26b%3Dc");
        assert_eq!(q("my db"), "my%20db");
        assert_eq!(q("a#b?c"), "a%23b%3Fc");
        assert_eq!(q("100%"), "100%25");
        assert_eq!(q("a+b"), "a%2Bb");
        // Non-ASCII goes out as UTF-8 bytes, which is what the parser expects.
        assert_eq!(q("naïve"), "na%C3%AFve");
    }
}
