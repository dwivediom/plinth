//! Native menu bar (PLAN-3-DESIGN §1.10). Every item id is the matching
//! action id in `src/app/actions.ts`; activating an item emits the id on
//! `plinth://menu` and the UI dispatches it exactly like the keyboard chord.
//!
//! The accelerators shown here are the same chords the webview already binds.
//! On macOS the menu's key equivalents are matched before the webview sees
//! the key, so the UI must treat a `plinth://menu` event as authoritative.

#[cfg(target_os = "macos")]
use tauri::menu::AboutMetadataBuilder;
use tauri::menu::{Menu, MenuBuilder, MenuEvent, MenuItem, MenuItemBuilder, Submenu, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Runtime};

/// Event channel for menu activations. Payload: the item id (a string).
pub const MENU_EVENT: &str = "plinth://menu";

fn item<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    text: &str,
    accel: Option<&str>,
) -> tauri::Result<MenuItem<R>> {
    let mut b = MenuItemBuilder::with_id(id, text);
    if let Some(a) = accel {
        b = b.accelerator(a);
    }
    b.build(app)
}

#[cfg(target_os = "macos")]
fn app_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Submenu<R>> {
    let about = AboutMetadataBuilder::new()
        .name(Some("Plinth"))
        .version(Some(env!("CARGO_PKG_VERSION")))
        .comments(Some("A native database client with a built-in MCP server."))
        .license(Some("AGPL-3.0-only"))
        .website(Some("https://github.com/od/plinth"))
        .build();
    SubmenuBuilder::new(app, "Plinth")
        .about_with_text("About Plinth", Some(about))
        .separator()
        .item(&item(app, "settings", "Settings…", Some("CmdOrCtrl+,"))?)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()
}

fn file_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Submenu<R>> {
    let b = SubmenuBuilder::new(app, "File")
        .item(&item(app, "new-window", "New Window", Some("CmdOrCtrl+Alt+N"))?)
        .separator()
        .item(&item(app, "new-query", "New Query", Some("CmdOrCtrl+T"))?)
        .item(&item(app, "json-viewer", "New JSON Viewer", Some("CmdOrCtrl+Shift+J"))?)
        .item(&item(app, "close-tab", "Close Tab", Some("CmdOrCtrl+W"))?)
        .separator()
        .item(&item(app, "save", "Save", Some("CmdOrCtrl+S"))?);
    // Outside macOS there is no app menu, so Settings and Quit live here.
    #[cfg(not(target_os = "macos"))]
    let b = b
        .separator()
        .item(&item(app, "settings", "Settings…", Some("CmdOrCtrl+,"))?)
        .separator()
        .item(&item(app, "quit", "Quit", Some("CmdOrCtrl+Q"))?);
    b.build()
}

fn edit_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Submenu<R>> {
    SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()
}

fn view_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Submenu<R>> {
    SubmenuBuilder::new(app, "View")
        .item(&item(app, "toggle-sidebar", "Toggle Sidebar", Some("CmdOrCtrl+Alt+S"))?)
        .item(&item(app, "toggle-inspector", "Toggle Inspector", Some("CmdOrCtrl+I"))?)
        .item(&item(app, "toggle-console", "Toggle Console", Some("CmdOrCtrl+Shift+C"))?)
        .separator()
        .item(&item(app, "reload", "Reload", Some("CmdOrCtrl+R"))?)
        .build()
}

fn connection_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Submenu<R>> {
    SubmenuBuilder::new(app, "Connection")
        .item(&item(app, "new-connection", "New Connection…", Some("CmdOrCtrl+Shift+N"))?)
        .item(&item(app, "conn-switcher", "Connect…", Some("CmdOrCtrl+Shift+K"))?)
        .item(&item(app, "db-switcher", "Switch Database…", Some("CmdOrCtrl+K"))?)
        .separator()
        .item(&item(app, "reconnect", "Reconnect", None)?)
        .item(&item(app, "disconnect", "Disconnect", None)?)
        .build()
}

fn query_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Submenu<R>> {
    SubmenuBuilder::new(app, "Query")
        .item(&item(app, "run-current", "Run", Some("CmdOrCtrl+Enter"))?)
        .item(&item(app, "run-all", "Run All", Some("CmdOrCtrl+Shift+Enter"))?)
        .item(&item(app, "cancel", "Cancel", Some("CmdOrCtrl+."))?)
        .separator()
        // ⌘I is shared with View › Toggle Inspector; the webview disambiguates
        // by editor focus, so the menu item carries no accelerator of its own.
        .item(&item(app, "beautify", "Beautify", None)?)
        .build()
}

fn navigate_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Submenu<R>> {
    SubmenuBuilder::new(app, "Navigate")
        .item(&item(app, "back", "Back", Some("CmdOrCtrl+["))?)
        .item(&item(app, "forward", "Forward", Some("CmdOrCtrl+]"))?)
        .separator()
        .item(&item(app, "open-anything", "Open Anything…", Some("CmdOrCtrl+P"))?)
        .separator()
        .item(&item(app, "next-tab", "Next Tab", Some("Ctrl+Tab"))?)
        .item(&item(app, "prev-tab", "Previous Tab", Some("Ctrl+Shift+Tab"))?)
        .build()
}

fn window_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Submenu<R>> {
    SubmenuBuilder::new(app, "Window")
        .item(&item(app, "new-window", "New Window", Some("CmdOrCtrl+Alt+N"))?)
        .separator()
        .minimize()
        .maximize_with_text("Zoom")
        .fullscreen()
        .separator()
        // Not the predefined Close Window: it takes ⌘W, which is Close Tab
        // here. ⌘W closes the tab, ⇧⌘W closes the window — as in a browser.
        .item(&item(app, "close-window", "Close Window", Some("CmdOrCtrl+Shift+W"))?)
        .build()
}

fn help_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Submenu<R>> {
    SubmenuBuilder::new(app, "Help")
        .item(&item(app, "shortcuts", "Keyboard Shortcuts", Some("CmdOrCtrl+/"))?)
        .item(&item(app, "documentation", "Documentation", None)?)
        .build()
}

/// Build the full menu bar. On macOS the first submenu becomes the app menu.
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let mut b = MenuBuilder::new(app);
    #[cfg(target_os = "macos")]
    {
        b = b.item(&app_menu(app)?);
    }
    b = b
        .item(&file_menu(app)?)
        .item(&edit_menu(app)?)
        .item(&view_menu(app)?)
        .item(&connection_menu(app)?)
        .item(&query_menu(app)?)
        .item(&navigate_menu(app)?)
        .item(&window_menu(app)?)
        .item(&help_menu(app)?);
    b.build()
}

/// Forward a menu activation to the webview.
pub fn on_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    let id = event.id().as_ref().to_string();
    if id == "quit" {
        app.exit(0);
        return;
    }
    if id == "documentation" {
        use tauri_plugin_opener::OpenerExt;
        if let Err(e) = app.opener().open_url("https://github.com/od/plinth#readme", None::<&str>) {
            tracing::warn!(error = %e, "could not open documentation");
        }
        return;
    }
    if let Err(e) = app.emit(MENU_EVENT, id) {
        tracing::warn!(error = %e, "menu event emit failed");
    }
}
