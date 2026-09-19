import { bus } from "../lib/bus";
import { chordLabel } from "../lib/keys";
import { confirm, prompt } from "../state/overlays";
import { isTabDirty } from "../state/types";
import { closeWindow, openWindow } from "../lib/windows";
import { useUi } from "../state/ui";
import { useWorkspaces } from "../state/workspaces";

export interface Action {
  id: string;
  label: string;
  /** chord string understood by lib/keys.matches */
  chord?: string;
  /** shown in the palette under "Commands"; default true */
  palette?: boolean;
  group: "Tabs" | "Navigate" | "View" | "Query" | "Data" | "App";
  /** Extra condition for the shortcut (the palette ignores it). */
  when?: () => boolean;
  run: () => void;
}

export const editorFocused = () => !!document.activeElement?.closest(".cm-editor");

const ws = () => {
  const s = useWorkspaces.getState();
  return s.activeId ? s.byId[s.activeId] : undefined;
};

export async function closeTabWithConfirm(wsId: string, tabId: string): Promise<boolean> {
  const st = useWorkspaces.getState();
  const w = st.byId[wsId];
  const tab = w?.tabs.find((t) => t.id === tabId);
  if (!w || !tab) return false;
  if (isTabDirty(tab)) {
    if (tab.kind === "table") {
      const r = await confirm({
        title: `“${tab.title}” has unsaved changes.`,
        message: "Your edits haven't been saved to the database.",
        buttons: [
          { label: "Cancel", value: "cancel", role: "cancel" },
          { label: "Revert", value: "revert", role: "destructive" },
          { label: "Save", value: "save", role: "default" },
        ],
      });
      if (r === "cancel") return false;
      if (r === "save") {
        st.activateTab(wsId, tabId);
        bus.emit("save");
        return false;
      }
    } else {
      const r = await confirm({
        title: `Close “${tab.title}”?`,
        message: "The query text hasn't been saved. It stays in Reopen Closed Tab until you quit.",
        buttons: [
          { label: "Cancel", value: "cancel", role: "cancel" },
          { label: "Close", value: "close", role: "destructive" },
        ],
      });
      if (r !== "close") return false;
    }
  }
  st.closeTab(wsId, tabId);
  return true;
}

export const actions: Action[] = [
  // Tabs
  { id: "new-query", label: "New Query Tab", chord: "Mod+T", group: "Tabs", run: () => { const w = ws(); if (w) useWorkspaces.getState().openQuery(w.info.id); } },
  { id: "close-tab", label: "Close Tab", chord: "Mod+W", group: "Tabs", run: () => { const w = ws(); if (w?.activeTabId) void closeTabWithConfirm(w.info.id, w.activeTabId); } },
  { id: "reopen-tab", label: "Reopen Closed Tab", chord: "Mod+Shift+T", group: "Tabs", run: () => { const w = ws(); if (w) useWorkspaces.getState().reopenClosed(w.info.id); } },
  { id: "next-tab", label: "Next Tab", chord: "Ctrl+Tab", group: "Tabs", run: () => cycleTab(1) },
  { id: "prev-tab", label: "Previous Tab", chord: "Ctrl+Shift+Tab", group: "Tabs", run: () => cycleTab(-1) },
  { id: "move-tab-right", label: "Move Tab Right", chord: "Mod+Alt+ArrowRight", group: "Tabs", palette: false, run: () => { const w = ws(); if (w?.activeTabId) useWorkspaces.getState().moveTab(w.info.id, w.activeTabId, 1); } },
  { id: "move-tab-left", label: "Move Tab Left", chord: "Mod+Alt+ArrowLeft", group: "Tabs", palette: false, run: () => { const w = ws(); if (w?.activeTabId) useWorkspaces.getState().moveTab(w.info.id, w.activeTabId, -1); } },
  { id: "rename-tab", label: "Rename Tab…", chord: "Mod+Shift+R", group: "Tabs", run: () => void renameActiveTab() },
  { id: "all-tabs", label: "Show All Tabs", chord: "Mod+Shift+\\", group: "Tabs", run: () => useUi.getState().setOverlay({ kind: "all-tabs" }) },
  // Navigate
  { id: "back", label: "Back", chord: "Mod+[", group: "Navigate", run: () => { const w = ws(); if (w) useWorkspaces.getState().goBack(w.info.id); } },
  { id: "forward", label: "Forward", chord: "Mod+]", group: "Navigate", run: () => { const w = ws(); if (w) useWorkspaces.getState().goForward(w.info.id); } },
  { id: "open-anything", label: "Open Anything…", chord: "Mod+P", group: "Navigate", palette: false, run: () => useUi.getState().setOverlay({ kind: "palette" }) },
  { id: "db-switcher", label: "Switch Database…", chord: "Mod+K", group: "Navigate", run: () => useUi.getState().setOverlay({ kind: "db-switcher" }) },
  { id: "conn-switcher", label: "Switch Connection…", chord: "Mod+Shift+K", group: "Navigate", run: () => useUi.getState().setOverlay({ kind: "conn-switcher" }) },
  { id: "compare-schema", label: "Compare Schema…", chord: "Mod+Shift+D", group: "Navigate", run: () => { const w = ws(); if (w) useWorkspaces.getState().openDiff(w.info.id); } },
  { id: "schema-map", label: "Schema Map", chord: "Mod+Shift+M", group: "Navigate", run: () => { const w = ws(); if (w) useWorkspaces.getState().openMap(w.info.id); } },
  { id: "search-tables", label: "Search Tables", chord: "Mod+Shift+O", group: "Navigate", run: () => { const ui = useUi.getState(); if (!ui.sidebarVisible) ui.toggleSidebar(); ui.setSidebarPane("items"); setTimeout(() => bus.emit("focus-sidebar-search"), 0); } },
  { id: "next-workspace", label: "Next Workspace", chord: "Mod+Shift+]", group: "Navigate", run: () => useWorkspaces.getState().cycle(1) },
  { id: "prev-workspace", label: "Previous Workspace", chord: "Mod+Shift+[", group: "Navigate", run: () => useWorkspaces.getState().cycle(-1) },
  { id: "launcher", label: "Show Connections Window", group: "Navigate", run: () => useUi.getState().setShowLauncher(true) },
  // View
  { id: "toggle-sidebar", label: "Toggle Sidebar", chord: "Mod+Alt+S", group: "View", run: () => useUi.getState().toggleSidebar() },
  { id: "toggle-inspector", label: "Toggle Inspector", chord: "Mod+I", group: "View", when: () => !editorFocused(), run: () => useUi.getState().toggleInspector() },
  { id: "toggle-console", label: "Toggle Console", chord: "Mod+Shift+C", group: "View", run: () => useUi.getState().toggleConsole() },
  { id: "toggle-filter", label: "Toggle Filter Bar", chord: "Mod+F", group: "Data", when: () => !editorFocused(), run: () => bus.emit("toggle-filter-bar") },
  { id: "reload", label: "Reload", chord: "Mod+R", group: "View", run: () => { bus.emit("reload"); const w = ws(); if (w) void useWorkspaces.getState().loadSchema(w.info.id, true); } },
  {
    id: "json-viewer",
    label: "New JSON Viewer",
    chord: "Mod+Shift+J",
    group: "Tabs",
    run: () => {
      const w = ws();
      if (w) useWorkspaces.getState().openJson(w.info.id, "", { title: "JSON" });
      else useUi.getState().setOverlay({ kind: "json-scratch" });
    },
  },
  { id: "new-window", label: "New Window", chord: "Mod+Alt+N", group: "App", run: () => void openWindow() },
  { id: "close-window", label: "Close Window", chord: "Mod+Shift+W", group: "App", run: () => void closeWindow() },
  { id: "guide", label: "Guide & Features", chord: "Mod+Shift+/", group: "App", run: () => useUi.getState().setOverlay({ kind: "guide" }) },
  { id: "shortcuts", label: "Keyboard Shortcuts", chord: "Mod+/", group: "App", run: () => useUi.getState().setOverlay({ kind: "shortcuts" }) },
  { id: "settings", label: "Settings…", chord: "Mod+,", group: "App", run: () => useUi.getState().setOverlay({ kind: "settings" }) },
  { id: "new-connection", label: "New Connection…", group: "App", run: () => useUi.getState().setOverlay({ kind: "driver-picker" }) },
  // Query
  { id: "run-current", label: "Run Current Statement", chord: "Mod+Enter", group: "Query", run: () => bus.emit("run", { mode: "current" }) },
  { id: "run-all", label: "Run All", chord: "Mod+Shift+Enter", group: "Query", run: () => bus.emit("run", { mode: "all" }) },
  { id: "cancel", label: "Cancel Query", chord: "Mod+.", group: "Query", run: () => bus.emit("cancel") },
  { id: "beautify", label: "Beautify SQL", chord: "Mod+I", group: "Query", when: editorFocused, run: () => bus.emit("beautify") },
  { id: "save", label: "Save", chord: "Mod+S", group: "Data", run: () => bus.emit("save") },
  { id: "new-row", label: "New Row", chord: "Mod+N", group: "Data", run: () => bus.emit("new-row") },
  { id: "duplicate-row", label: "Duplicate Row", chord: "Mod+D", group: "Data", when: () => !editorFocused(), run: () => bus.emit("duplicate-row") },
  { id: "safe-mode", label: "Toggle Safe Mode", chord: "Mod+Shift+L", group: "Data", run: () => void toggleSafeMode() },
];

for (let n = 1; n <= 9; n++) {
  actions.push({ id: `tab-${n}`, label: `Go to Tab ${n === 9 ? "Last" : n}`, chord: `Mod+${n}`, group: "Tabs", palette: false, run: () => jumpTab(n) });
}

function cycleTab(delta: number) {
  const w = ws();
  if (!w || w.tabs.length < 2) return;
  const i = w.tabs.findIndex((t) => t.id === w.activeTabId);
  const next = w.tabs[(i + delta + w.tabs.length) % w.tabs.length];
  useWorkspaces.getState().activateTab(w.info.id, next.id);
}

function jumpTab(n: number) {
  const w = ws();
  if (!w || !w.tabs.length) return;
  const t = n === 9 ? w.tabs[w.tabs.length - 1] : w.tabs[n - 1];
  if (t) useWorkspaces.getState().activateTab(w.info.id, t.id);
}

async function renameActiveTab() {
  const w = ws();
  const tab = w?.tabs.find((t) => t.id === w.activeTabId);
  if (!w || !tab) return;
  const name = await prompt("Rename Tab", tab.title);
  if (name) useWorkspaces.getState().renameTab(w.info.id, tab.id, name);
}

export async function toggleSafeMode() {
  const w = ws();
  if (!w) return;
  const st = useWorkspaces.getState();
  if (w.info.policy === "read-only") {
    await confirm({ title: "This connection is read-only.", message: "Its policy is set to read-only in the connection settings, so safe mode can't be turned off here.", buttons: [{ label: "OK", value: "ok", role: "default" }] });
    return;
  }
  if (w.safeMode) {
    if (w.info.environment === "production") {
      const r = await confirm({
        title: `Allow writes on ${w.info.connectionName}?`,
        message: "This is a production connection. Edits, inserts and deletes will be sent to the database when you save.",
        buttons: [
          { label: "Cancel", value: "cancel", role: "cancel" },
          { label: "Allow Writes", value: "ok", role: "destructive" },
        ],
      });
      if (r !== "ok") return;
    }
    st.setSafeMode(w.info.id, false);
  } else st.setSafeMode(w.info.id, true);
}

export const actionById = (id: string) => actions.find((a) => a.id === id);
export const shortcutLabel = (id: string) => {
  const a = actionById(id);
  return a?.chord ? chordLabel(a.chord) : "";
};
