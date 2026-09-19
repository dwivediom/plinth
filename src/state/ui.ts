import { create } from "zustand";
import { invoke } from "../ipc/client";
import type { ConnectionProfile, JsonValue } from "../ipc/types";

export type Theme = "system" | "light" | "dark";
export type SidebarPane = "items" | "queries" | "history";

export type Overlay =
  | { kind: "palette" }
  | { kind: "db-switcher" }
  | { kind: "conn-switcher" }
  | { kind: "all-tabs" }
  | { kind: "shortcuts" }
  | { kind: "guide" }
  /** The JSON viewer with no database behind it — paste and read. */
  | { kind: "json-scratch" }
  /** One document, enlarged over the app, with the row still behind it. */
  | { kind: "json-zoom"; text: string; title: string; sqlColumn?: string | null }
  | { kind: "settings" }
  | { kind: "driver-picker" }
  | { kind: "connection-sheet"; profile: ConnectionProfile | null; connectAfter: boolean; password?: string | null }
  | null;

interface Prefs {
  theme: Theme;
  defaultLimit: number | null;
  sidebarWidth: number;
  sidebarVisible: boolean;
  inspectorVisible: boolean;
  consoleVisible: boolean;
  consoleHeight: number;
  editorSplit: number;
}

interface UiState extends Prefs {
  windowFocused: boolean;
  overlay: Overlay;
  sidebarPane: SidebarPane;
  showLauncher: boolean;
  inspectorPane: "details" | "ai";
  consoleFilter: "all" | "app" | "user" | "ai";
  prefsLoaded: boolean;
  setTheme(t: Theme): void;
  setPref<K extends keyof Prefs>(k: K, v: Prefs[K]): void;
  toggleSidebar(): void;
  toggleInspector(): void;
  toggleConsole(): void;
  setOverlay(o: Overlay): void;
  closeOverlay(): void;
  setSidebarPane(p: SidebarPane): void;
  setInspectorPane(p: "details" | "ai"): void;
  setConsoleFilter(f: "all" | "app" | "user" | "ai"): void;
  setWindowFocused(f: boolean): void;
  setShowLauncher(v: boolean): void;
  loadPrefs(): Promise<void>;
}

const defaultPrefs: Prefs = {
  theme: "system",
  defaultLimit: 1000,
  sidebarWidth: 220,
  sidebarVisible: true,
  inspectorVisible: false,
  consoleVisible: false,
  consoleHeight: 160,
  editorSplit: 0.4,
};

function applyTheme(t: Theme) {
  const root = document.documentElement;
  if (t === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", t);
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePrefsSave(get: () => UiState) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const s = get();
    const prefs: Prefs = {
      theme: s.theme,
      defaultLimit: s.defaultLimit,
      sidebarWidth: s.sidebarWidth,
      sidebarVisible: s.sidebarVisible,
      inspectorVisible: s.inspectorVisible,
      consoleVisible: s.consoleVisible,
      consoleHeight: s.consoleHeight,
      editorSplit: s.editorSplit,
    };
    invoke("state_set", { key: "prefs", value: prefs as unknown as JsonValue }).catch(() => {});
  }, 500);
}

export const useUi = create<UiState>((set, get) => ({
  ...defaultPrefs,
  windowFocused: typeof document === "undefined" ? true : document.hasFocus(),
  overlay: null,
  sidebarPane: "items",
  showLauncher: false,
  inspectorPane: "details",
  consoleFilter: "all",
  prefsLoaded: false,

  setTheme(theme) {
    applyTheme(theme);
    set({ theme });
    schedulePrefsSave(get);
  },
  setPref(k, v) {
    set({ [k]: v } as Partial<Prefs>);
    schedulePrefsSave(get);
  },
  toggleSidebar() {
    set((s) => ({ sidebarVisible: !s.sidebarVisible }));
    schedulePrefsSave(get);
  },
  toggleInspector() {
    set((s) => ({ inspectorVisible: !s.inspectorVisible }));
    schedulePrefsSave(get);
  },
  toggleConsole() {
    set((s) => ({ consoleVisible: !s.consoleVisible }));
    schedulePrefsSave(get);
  },
  setOverlay: (overlay) => set({ overlay }),
  closeOverlay: () => set({ overlay: null }),
  setSidebarPane: (sidebarPane) => set({ sidebarPane }),
  setInspectorPane: (inspectorPane) => set({ inspectorPane }),
  setConsoleFilter: (consoleFilter) => set({ consoleFilter }),
  setWindowFocused: (windowFocused) => set({ windowFocused }),
  setShowLauncher: (showLauncher) => set({ showLauncher }),

  async loadPrefs() {
    try {
      const v = (await invoke("state_get", { key: "prefs" })) as Partial<Prefs> | null;
      if (v && typeof v === "object") {
        const merged = { ...defaultPrefs, ...v };
        applyTheme(merged.theme);
        set({ ...merged, prefsLoaded: true });
        return;
      }
    } catch {
      /* ignore */
    }
    set({ prefsLoaded: true });
  },
}));
