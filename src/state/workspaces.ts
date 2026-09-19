import { create } from "zustand";
import { errorMessage, invoke } from "../ipc/client";
import type { Cell, ConnectionState, Filter, JsonValue, ObjectInfo, SavedQuery, TableRef, WorkspaceInfo, WorkspaceId } from "../ipc/types";
import { autoTitle } from "../lib/sql";
import { focusWindow, isMainWindow, liveWindows, openWindow, windowLabel } from "../lib/windows";
import { toast } from "./overlays";
import { changeCount, emptyChanges, isTabDirty, newId, pkKey, sameTable, type ChartForm, type ChartTab, type DiffTab, type JsonTab, type PlanTab, type MapTab, type QueryTab, type Tab, type TableTab, type Workspace } from "./types";
import { useData } from "./data";
import { useUi } from "./ui";

const useUiLimit = () => useUi.getState().defaultLimit;

interface OpenOpts {
  /** Force a new tab regardless of the current one. */
  newTab?: boolean;
  /** Pin immediately (double-click). */
  pin?: boolean;
  /** Initial filters (FK navigation). */
  filters?: Filter[];
  view?: "data" | "structure";
}

interface WorkspacesState {
  byId: Record<WorkspaceId, Workspace>;
  order: WorkspaceId[];
  activeId: WorkspaceId | null;
  opening: boolean;

  bootstrap(): Promise<void>;
  /** Hand every workspace back to the engine — the window is closing. */
  releaseAll(): Promise<void>;
  /** Connect inside *this* window. `launch` is what the UI calls; this is
   *  the primitive a freshly opened window uses to connect to its own
   *  connection, and `launch`'s fallback when no window can be created. */
  open(connectionId: string, database?: string | null): Promise<WorkspaceId | null>;
  /**
   * The one way a person opens a database: in its own window. Already open
   * somewhere? That window comes forward. `open` stays the in-window
   * primitive a fresh window uses to connect to what it was opened for.
   */
  launch(connectionId: string, database?: string | null): Promise<void>;
  adopt(info: WorkspaceInfo): Promise<WorkspaceId>;
  close(id: WorkspaceId): Promise<void>;
  reconnect(id: WorkspaceId): Promise<void>;
  setActive(id: WorkspaceId): void;
  cycle(delta: number): void;
  loadSchema(id: WorkspaceId, refresh?: boolean): Promise<void>;
  setConnState(id: WorkspaceId, state: ConnectionState, detail: string | null): void;
  toggleFavorite(id: WorkspaceId, obj: TableRef): void;
  setSafeMode(id: WorkspaceId, on: boolean): void;
  setRunning(id: WorkspaceId, tabId: string, running: boolean): void;

  // tabs
  openObject(id: WorkspaceId, obj: ObjectInfo | (TableRef & { kind?: ObjectInfo["kind"] }), opts?: OpenOpts): string;
  openQuery(id: WorkspaceId, text?: string, opts?: OpenOpts & { title?: string; limit?: number | null; autoRun?: boolean; source?: "user" | "ai" }): string;
  openSaved(id: WorkspaceId, q: SavedQuery, opts?: OpenOpts): string;
  openMap(id: WorkspaceId): string;
  openChart(id: WorkspaceId, sql: string, opts?: { title?: string; form?: ChartForm }): string;
  openDiff(id: WorkspaceId): string;
  openPlan(id: WorkspaceId, sql: string, planJson: string, analyzed: boolean): string;
  /** A JSON document in its own tab. Empty text opens the scratch viewer. */
  openJson(id: WorkspaceId, text: string, opts?: { title?: string; origin?: string | null; sqlColumn?: string | null }): string;
  activateTab(id: WorkspaceId, tabId: string, opts?: { history?: boolean }): void;
  closeTab(id: WorkspaceId, tabId: string): void;
  closeOthers(id: WorkspaceId, tabId: string): void;
  closeRight(id: WorkspaceId, tabId: string): void;
  reopenClosed(id: WorkspaceId): void;
  pinTab(id: WorkspaceId, tabId: string, pinned?: boolean): void;
  renameTab(id: WorkspaceId, tabId: string, title: string): void;
  moveTab(id: WorkspaceId, tabId: string, delta: number): void;
  goBack(id: WorkspaceId): void;
  goForward(id: WorkspaceId): void;
  updateTab<T extends Tab>(id: WorkspaceId, tabId: string, patch: Partial<T> | ((t: T) => Partial<T>)): void;
  setQueryText(id: WorkspaceId, tabId: string, text: string, cursor?: number): void;
  markSaved(id: WorkspaceId, tabId: string, saved: SavedQuery): void;

  // grid edits
  setCellChange(id: WorkspaceId, tabId: string, pk: Record<string, Cell>, column: string, value: Cell, original: Cell): void;
  revertChanges(id: WorkspaceId, tabId: string): void;
  addInsert(id: WorkspaceId, tabId: string, values: Record<string, Cell>): void;
  updateInsert(id: WorkspaceId, tabId: string, index: number, column: string, value: Cell): void;
  removeInsert(id: WorkspaceId, tabId: string, index: number): void;
  toggleDelete(id: WorkspaceId, tabId: string, pk: Record<string, Cell>): void;

  persist(id: WorkspaceId): void;
}

const stateKey = (info: WorkspaceInfo) => `workspace:${info.connectionId}:${info.database}`;

/**
 * Who holds what.
 *
 * Workspaces live in the engine and are visible to every window, so each
 * window has to say which ones are its own — otherwise all of them would show
 * all of them, and two windows would fight over one database's persisted
 * tabs. The registry is a single shared key: window label → what it holds.
 */
const REGISTRY = "windows";
type Held = { id: WorkspaceId; connectionId: string; database: string };
type Registry = Record<string, Held[]>;

async function readRegistry(): Promise<Registry> {
  try {
    const raw = (await invoke("state_get", { key: REGISTRY })) as Registry | null;
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

/** Rewrite this window's entry. Other windows' entries are never touched. */
async function writeRegistry(held: Held[]): Promise<void> {
  try {
    const reg = await readRegistry();
    if (held.length) reg[windowLabel()] = held;
    else delete reg[windowLabel()];
    await invoke("state_set", { key: REGISTRY, value: reg as unknown as JsonValue });
  } catch {
    /* the registry is a convenience; losing it costs a duplicate window */
  }
}

/** Everything this window currently holds, from the store. */
function heldNow(state: { byId: Record<string, Workspace> }): Held[] {
  return Object.values(state.byId).map((w) => ({ id: w.info.id, connectionId: w.info.connectionId, database: w.info.database }));
}

interface PersistedWorkspace {
  tabs: Tab[];
  activeTabId: string | null;
  favorites: string[];
  back: string[];
  forward: string[];
  safeMode?: boolean;
}

const persistTimers = new Map<WorkspaceId, ReturnType<typeof setTimeout>>();

function makeWorkspace(info: WorkspaceInfo): Workspace {
  return {
    info,
    schema: null,
    schemaLoading: false,
    schemaError: null,
    tabs: [],
    activeTabId: null,
    back: [],
    forward: [],
    closed: [],
    connState: "up", // workspace_open only resolves once the driver is connected; the engine emits Up before we can subscribe
    connDetail: null,
    openedAt: Date.now(),
    favorites: [],
    safeMode: info.policy === "read-only" || info.environment === "production",
    restored: false,
    runningTabs: {},
  };
}

function newTableTab(obj: TableRef & { kind?: ObjectInfo["kind"] }, opts: OpenOpts): TableTab {
  return {
    id: newId("tab"),
    kind: "table",
    title: obj.name,
    preview: !opts.pin && !opts.newTab,
    table: { schema: obj.schema ?? null, name: obj.name },
    objectKind: obj.kind ?? "table",
    view: opts.view ?? "data",
    filters: opts.filters ?? [],
    sort: [],
    scrollTop: 0,
    hiddenColumns: [],
    quickFilter: "",
    selectedRow: null,
    showFilterBar: (opts.filters?.length ?? 0) > 0,
    changes: emptyChanges(),
  };
}

function nextQueryTitle(tabs: Tab[]): string {
  const used = new Set(tabs.filter((t) => t.kind === "query").map((t) => t.title));
  let n = 1;
  while (used.has(`Query ${n}`)) n++;
  return `Query ${n}`;
}

export const useWorkspaces = create<WorkspacesState>((set, get) => {
  const ws = (id: WorkspaceId) => get().byId[id];
  const patchWs = (id: WorkspaceId, patch: Partial<Workspace> | ((w: Workspace) => Partial<Workspace>)) => {
    set((s) => {
      const w = s.byId[id];
      if (!w) return s;
      const p = typeof patch === "function" ? patch(w) : patch;
      return { byId: { ...s.byId, [id]: { ...w, ...p } } };
    });
  };
  const patchTab = (id: WorkspaceId, tabId: string, fn: (t: Tab) => Tab) => {
    patchWs(id, (w) => ({ tabs: w.tabs.map((t) => (t.id === tabId ? fn(t) : t)) }));
    get().persist(id);
  };

  /** Insert or replace per the PLAN-4 open rules; returns the tab id that is now active. */
  function placeTab(id: WorkspaceId, tab: Tab, opts: OpenOpts): string {
    const w = ws(id);
    if (!w) return tab.id;
    const tabs = [...w.tabs];
    const cur = tabs.find((t) => t.id === w.activeTabId);
    const curIndex = cur ? tabs.indexOf(cur) : -1;
    let replaced = false;
    if (!opts.newTab && cur && cur.preview && !isTabDirty(cur)) {
      // rule 1: unmodified preview tab is replaced
      tabs[curIndex] = tab;
      replaced = true;
    }
    if (!replaced) {
      if (cur && isTabDirty(cur) && cur.preview) tabs[curIndex] = { ...cur, preview: false }; // rule 2: dirty preview gets pinned
      tabs.splice(curIndex + 1, 0, tab);
    }
    const back = w.activeTabId && w.activeTabId !== tab.id && !replaced ? [...w.back, w.activeTabId].slice(-50) : w.back;
    patchWs(id, { tabs, activeTabId: tab.id, back, forward: replaced ? w.forward : [] });
    get().persist(id);
    return tab.id;
  }

  return {
    byId: {},
    order: [],
    activeId: null,
    opening: false,

    async bootstrap() {
      try {
        const [live, reg, alive] = await Promise.all([invoke("workspace_list", {}), readRegistry(), liveWindows()]);
        // A window that went away without tidying up leaves its claim behind.
        for (const label of Object.keys(reg)) if (!alive.includes(label)) delete reg[label];
        const mine = new Set((reg[windowLabel()] ?? []).map((h) => h.id));
        const theirs = new Set(Object.entries(reg).flatMap(([l, hs]) => (l === windowLabel() ? [] : hs.map((h) => h.id))));
        // Ours first; then, in the main window only, anything a crashed window
        // left behind — so a reconnect is never needed to get back to it.
        const adopt = live.filter((w) => mine.has(w.id) || (isMainWindow() && !theirs.has(w.id)));
        for (const info of adopt) await get().adopt(info);
        if (adopt.length && !get().activeId) set({ activeId: adopt[0].id });
        void writeRegistry(heldNow(get()));
      } catch (e) {
        console.warn("workspace_list failed", e);
      }
    },

    /** Give every workspace back before the window goes. */
    async releaseAll() {
      const ids = Object.keys(get().byId);
      await writeRegistry([]);
      // Together, not one after another: a closing window gives this whole
      // step a few seconds, and five pools closing in series can spend it
      // before the second one is done.
      await Promise.all(ids.map((id) => invoke("workspace_close", { workspaceId: id }).catch(() => {})));
    },

    async launch(connectionId, database) {
      // Already open? Go there. Opening it twice would mean two windows
      // overwriting one database's tabs.
      const reg = await readRegistry();
      const alive = await liveWindows();
      for (const [label, held] of Object.entries(reg)) {
        if (!alive.includes(label)) continue;
        const hit = held.find((h) => h.connectionId === connectionId && (database == null || h.database === database));
        if (!hit) continue;
        if (label === windowLabel()) {
          set({ activeId: hit.id });
          useUi.getState().setShowLauncher(false);
          return;
        }
        if (await focusWindow(label)) return;
      }
      if (await openWindow({ connectionId, database })) {
        // A window that has work of its own goes back to it.
        if (get().order.length) useUi.getState().setShowLauncher(false);
        return;
      }
      // No window to be had — better here than nowhere.
      const id = await get().open(connectionId, database);
      if (id) useUi.getState().setShowLauncher(false);
    },

    async open(connectionId, database) {
      set({ opening: true });
      try {
        const info = await invoke("workspace_open", { connectionId, database: database ?? null });
        const existing = Object.values(get().byId).find((w) => w.info.connectionId === info.connectionId && w.info.database === info.database && w.info.id !== info.id);
        if (existing) {
          // already open — switch to it and drop the duplicate handle
          invoke("workspace_close", { workspaceId: info.id }).catch(() => {});
          set({ activeId: existing.info.id, opening: false });
          return existing.info.id;
        }
        const id = await get().adopt(info);
        set({ activeId: id, opening: false });
        return id;
      } catch (e) {
        set({ opening: false });
        toast(errorMessage(e), "error");
        return null;
      }
    },

    async adopt(info) {
      const w = makeWorkspace(info);
      set((s) => ({ byId: { ...s.byId, [info.id]: w }, order: s.order.includes(info.id) ? s.order : [...s.order, info.id] }));
      void writeRegistry(heldNow(get()));
      // restore persisted tabs
      try {
        const raw = (await invoke("state_get", { key: stateKey(info) })) as PersistedWorkspace | null;
        if (raw && typeof raw === "object" && Array.isArray(raw.tabs)) {
          const tabs = raw.tabs.filter((t) => t && typeof t.id === "string").map((t) => (t.kind === "table" ? { ...t, changes: t.changes ?? emptyChanges() } : t));
          const activeTabId = tabs.some((t) => t.id === raw.activeTabId) ? raw.activeTabId : (tabs[0]?.id ?? null);
          const safeMode = raw.safeMode ?? w.safeMode;
          patchWs(info.id, { tabs, activeTabId, favorites: raw.favorites ?? [], back: raw.back ?? [], forward: raw.forward ?? [], safeMode, restored: true });
          // The engine opened this workspace with its own default; a remembered
          // preference only counts once it has been told.
          if (safeMode !== (info.policy === "read-only" || info.environment === "production")) {
            void invoke("workspace_set_safe_mode", { workspaceId: info.id, on: safeMode }).catch(() => patchWs(info.id, { safeMode: true }));
          }
        } else patchWs(info.id, { restored: true });
      } catch {
        patchWs(info.id, { restored: true });
      }
      void get().loadSchema(info.id);
      return info.id;
    },

    async close(id) {
      const w = ws(id);
      if (!w) return;
      get().persist(id);
      const timer = persistTimers.get(id);
      if (timer) {
        clearTimeout(timer);
        persistTimers.delete(id);
        flushPersist(w);
      }
      set((s) => {
        const byId = { ...s.byId };
        delete byId[id];
        const order = s.order.filter((x) => x !== id);
        const activeId = s.activeId === id ? (order[Math.max(0, s.order.indexOf(id) - 1)] ?? order[0] ?? null) : s.activeId;
        return { byId, order, activeId };
      });
      useData.getState().dropWorkspace(w.tabs.map((t) => t.id));
      void writeRegistry(heldNow(get()));
      try {
        await invoke("workspace_close", { workspaceId: id });
      } catch {
        /* ignore */
      }
    },

    async reconnect(id) {
      const w = ws(id);
      if (!w) return;
      patchWs(id, { connState: "connecting", connDetail: "Reconnecting…" });
      try {
        const info = await invoke("workspace_open", { connectionId: w.info.connectionId, database: w.info.database });
        const oldId = id;
        set((s) => {
          const old = s.byId[oldId];
          if (!old) return s;
          const byId = { ...s.byId };
          delete byId[oldId];
          byId[info.id] = { ...old, info, connState: "up", connDetail: null, openedAt: Date.now() };
          return { byId, order: s.order.map((x) => (x === oldId ? info.id : x)), activeId: s.activeId === oldId ? info.id : s.activeId };
        });
        invoke("workspace_close", { workspaceId: oldId }).catch(() => {});
        useData.getState().resetResults(w.tabs.map((t) => t.id));
        void get().loadSchema(info.id, true);
      } catch (e) {
        patchWs(id, { connState: "down", connDetail: errorMessage(e) });
      }
    },

    setActive: (id) => set({ activeId: id }),

    cycle(delta) {
      const { order, activeId } = get();
      if (order.length < 2 || !activeId) return;
      const i = order.indexOf(activeId);
      set({ activeId: order[(i + delta + order.length) % order.length] });
    },

    async loadSchema(id, refresh = false) {
      patchWs(id, { schemaLoading: true, schemaError: null });
      try {
        const schema = await invoke("schema_index", { workspaceId: id, refresh });
        patchWs(id, { schema, schemaLoading: false });
      } catch (e) {
        patchWs(id, { schemaLoading: false, schemaError: errorMessage(e) });
      }
    },

    setConnState: (id, connState, connDetail) => patchWs(id, { connState, connDetail }),

    toggleFavorite(id, obj) {
      const key = `${obj.schema ?? ""}.${obj.name}`;
      patchWs(id, (w) => ({ favorites: w.favorites.includes(key) ? w.favorites.filter((f) => f !== key) : [...w.favorites, key] }));
      get().persist(id);
    },

    setSafeMode(id, on) {
      patchWs(id, { safeMode: on });
      get().persist(id);
      // The padlock is enforced in the engine; this is the window telling it
      // what the person just decided. If the call fails the engine keeps the
      // stricter state, which is the right way round to fail.
      void invoke("workspace_set_safe_mode", { workspaceId: id, on }).catch(() => {
        patchWs(id, { safeMode: true });
        toast("Could not change safe mode — it stays on.", "error");
      });
    },

    setRunning: (id, tabId, running) =>
      patchWs(id, (w) => {
        const runningTabs = { ...w.runningTabs };
        if (running) runningTabs[tabId] = true;
        else delete runningTabs[tabId];
        return { runningTabs };
      }),

    // ───────── tabs ─────────

    openObject(id, obj, opts = {}) {
      const w = ws(id);
      if (!w) return "";
      const ref: TableRef = { schema: obj.schema ?? null, name: obj.name };
      // rule 5: already open in a pinned tab → switch (unless explicitly asking for a new tab)
      if (!opts.newTab && !opts.filters) {
        const open = w.tabs.find((t) => t.kind === "table" && sameTable(t.table, ref) && !t.preview);
        if (open) {
          get().activateTab(id, open.id);
          if (opts.pin || opts.view) get().updateTab<TableTab>(id, open.id, { preview: false, ...(opts.view ? { view: opts.view } : {}) });
          return open.id;
        }
        const previewOpen = w.tabs.find((t) => t.kind === "table" && sameTable(t.table, ref) && t.preview);
        if (previewOpen) {
          get().activateTab(id, previewOpen.id);
          if (opts.pin) get().updateTab<TableTab>(id, previewOpen.id, { preview: false });
          if (opts.view) get().updateTab<TableTab>(id, previewOpen.id, { view: opts.view });
          return previewOpen.id;
        }
      }
      return placeTab(id, newTableTab(obj, opts), opts);
    },

    openQuery(id, text = "", opts = {}) {
      const w = ws(id);
      if (!w) return "";
      const tab: QueryTab = {
        id: newId("tab"),
        kind: "query",
        title: opts.title ?? (text ? autoTitle(text) || nextQueryTitle(w.tabs) : nextQueryTitle(w.tabs)),
        preview: false,
        savedId: null,
        text,
        savedText: "",
        cursor: text.length,
        limit: opts.limit === undefined ? useUiLimit() : opts.limit,
        customTitle: !!opts.title,
        selectedRow: null,
        autoRun: opts.autoRun,
        source: opts.source,
      };
      return placeTab(id, tab, { ...opts, newTab: true });
    },

    openMap(id) {
      const w = ws(id);
      if (!w) return "";
      // One map per workspace: a second ⌘⇧M focuses the one that is open.
      const existing = w.tabs.find((t) => t.kind === "map");
      if (existing) {
        get().activateTab(id, existing.id);
        return existing.id;
      }
      const tab: MapTab = { id: newId("tab"), kind: "map", title: "Schema Map", preview: false, filter: "", focus: null };
      return placeTab(id, tab, { newTab: true });
    },

    openPlan(id, sql, planJson, analyzed) {
      const tab: PlanTab = {
        id: newId("tab"),
        kind: "plan",
        title: analyzed ? "Plan (executed)" : "Plan",
        preview: false,
        sql,
        planJson,
        analyzed,
      };
      return placeTab(id, tab, { newTab: true });
    },

    openJson(id, text, opts = {}) {
      const tab: JsonTab = {
        id: newId("tab"),
        kind: "json",
        title: opts.title ?? (opts.origin ? `JSON · ${opts.origin}` : "JSON"),
        preview: false,
        text,
        origin: opts.origin ?? null,
        sqlColumn: opts.sqlColumn ?? null,
        // An empty tab is there to be pasted into, so it opens ready for it.
        editing: !text.trim(),
      };
      return placeTab(id, tab, { newTab: true });
    },

    openDiff(id) {
      const w = ws(id);
      if (!w) return "";
      const existing = w.tabs.find((t) => t.kind === "diff");
      if (existing) {
        get().activateTab(id, existing.id);
        return existing.id;
      }
      const tab: DiffTab = { id: newId("tab"), kind: "diff", title: "Compare Schema", preview: false, rightWorkspaceId: null };
      return placeTab(id, tab, { newTab: true });
    },

    openChart(id, sql, opts = {}) {
      const tab: ChartTab = {
        id: newId("tab"),
        kind: "chart",
        title: opts.title ?? "Chart",
        preview: false,
        sql,
        form: opts.form ?? "bar",
        x: null,
        y: null,
        showTable: false,
      };
      return placeTab(id, tab, { newTab: true });
    },

    openSaved(id, q, opts = {}) {
      const w = ws(id);
      if (!w) return "";
      const open = w.tabs.find((t) => t.kind === "saved" && t.savedId === q.id);
      if (open && !opts.newTab) {
        get().activateTab(id, open.id);
        return open.id;
      }
      const tab: QueryTab = {
        id: newId("tab"),
        kind: "saved",
        title: q.name,
        preview: !opts.pin && !opts.newTab,
        savedId: q.id,
        text: q.sql,
        savedText: q.sql,
        cursor: 0,
        limit: null,
        customTitle: true,
        selectedRow: null,
      };
      return placeTab(id, tab, opts);
    },

    activateTab(id, tabId, opts = { history: true }) {
      const w = ws(id);
      if (!w || w.activeTabId === tabId || !w.tabs.some((t) => t.id === tabId)) return;
      const back = opts.history !== false && w.activeTabId ? [...w.back, w.activeTabId].slice(-50) : w.back;
      patchWs(id, { activeTabId: tabId, back, forward: opts.history !== false ? [] : w.forward });
      get().persist(id);
    },

    closeTab(id, tabId) {
      const w = ws(id);
      if (!w) return;
      const i = w.tabs.findIndex((t) => t.id === tabId);
      if (i < 0) return;
      const tab = w.tabs[i];
      const tabs = w.tabs.filter((t) => t.id !== tabId);
      let activeTabId = w.activeTabId;
      if (activeTabId === tabId) {
        // prefer the most recent tab in history, else the neighbour
        const fromHistory = [...w.back].reverse().find((x) => tabs.some((t) => t.id === x));
        activeTabId = fromHistory ?? tabs[Math.min(i, tabs.length - 1)]?.id ?? null;
      }
      patchWs(id, {
        tabs,
        activeTabId,
        back: w.back.filter((x) => x !== tabId),
        forward: w.forward.filter((x) => x !== tabId),
        closed: [...w.closed, tab].slice(-20),
      });
      useData.getState().dropTab(tabId);
      get().persist(id);
    },

    closeOthers(id, tabId) {
      const w = ws(id);
      if (!w) return;
      const keep = w.tabs.filter((t) => t.id === tabId || isTabDirty(t));
      const gone = w.tabs.filter((t) => !keep.includes(t));
      patchWs(id, { tabs: keep, activeTabId: tabId, back: [], forward: [], closed: [...w.closed, ...gone].slice(-20) });
      gone.forEach((t) => useData.getState().dropTab(t.id));
      get().persist(id);
    },

    closeRight(id, tabId) {
      const w = ws(id);
      if (!w) return;
      const i = w.tabs.findIndex((t) => t.id === tabId);
      const keep = w.tabs.filter((t, j) => j <= i || isTabDirty(t));
      const gone = w.tabs.filter((t) => !keep.includes(t));
      const activeTabId = keep.some((t) => t.id === w.activeTabId) ? w.activeTabId : tabId;
      patchWs(id, { tabs: keep, activeTabId, closed: [...w.closed, ...gone].slice(-20) });
      gone.forEach((t) => useData.getState().dropTab(t.id));
      get().persist(id);
    },

    reopenClosed(id) {
      const w = ws(id);
      if (!w || !w.closed.length) return;
      const tab = w.closed[w.closed.length - 1];
      patchWs(id, { closed: w.closed.slice(0, -1) });
      placeTab(id, { ...tab, preview: false }, { newTab: true });
    },

    pinTab(id, tabId, pinned = true) {
      patchTab(id, tabId, (t) => ({ ...t, preview: !pinned }));
    },

    renameTab(id, tabId, title) {
      patchTab(id, tabId, (t) => (t.kind === "table" ? { ...t, title } : { ...t, title, customTitle: true }));
    },

    moveTab(id, tabId, delta) {
      const w = ws(id);
      if (!w) return;
      const i = w.tabs.findIndex((t) => t.id === tabId);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= w.tabs.length) return;
      const tabs = [...w.tabs];
      [tabs[i], tabs[j]] = [tabs[j], tabs[i]];
      patchWs(id, { tabs });
      get().persist(id);
    },

    goBack(id) {
      const w = ws(id);
      if (!w) return;
      const back = [...w.back];
      let target: string | undefined;
      while (back.length) {
        const cand = back.pop()!;
        if (w.tabs.some((t) => t.id === cand)) {
          target = cand;
          break;
        }
      }
      if (!target) return;
      patchWs(id, { back, forward: w.activeTabId ? [...w.forward, w.activeTabId] : w.forward, activeTabId: target });
      get().persist(id);
    },

    goForward(id) {
      const w = ws(id);
      if (!w) return;
      const forward = [...w.forward];
      let target: string | undefined;
      while (forward.length) {
        const cand = forward.pop()!;
        if (w.tabs.some((t) => t.id === cand)) {
          target = cand;
          break;
        }
      }
      if (!target) return;
      patchWs(id, { forward, back: w.activeTabId ? [...w.back, w.activeTabId] : w.back, activeTabId: target });
      get().persist(id);
    },

    updateTab(id, tabId, patch) {
      patchTab(id, tabId, (t) => ({ ...t, ...(typeof patch === "function" ? (patch as unknown as (x: Tab) => Partial<Tab>)(t) : patch) }) as Tab);
    },

    setQueryText(id, tabId, text, cursor) {
      patchTab(id, tabId, (t) => {
        if (t.kind === "table") return t;
        const q = t as QueryTab;
        const title = q.customTitle ? q.title : autoTitle(text) || q.title;
        const wasPreview = q.preview && text.trim() !== q.savedText.trim();
        return { ...q, text, cursor: cursor ?? q.cursor, title, preview: wasPreview ? false : q.preview };
      });
    },

    markSaved(id, tabId, saved) {
      patchTab(id, tabId, (t) => (t.kind !== "query" && t.kind !== "saved" ? t : { ...t, kind: "saved", savedId: saved.id, savedText: saved.sql, title: saved.name, customTitle: true, preview: false }));
    },

    // ───────── grid edits ─────────

    setCellChange(id, tabId, pk, column, value, original) {
      patchTab(id, tabId, (t) => {
        if (t.kind !== "table") return t;
        const key = `${pkKey(pk)}\u0000${column}`;
        const updates = { ...t.changes.updates };
        const same = JSON.stringify(value) === JSON.stringify(original);
        if (same) delete updates[key];
        else updates[key] = { pk, column, value, original };
        const changes = { ...t.changes, updates };
        return { ...t, changes, preview: changeCount(changes) ? false : t.preview };
      });
    },

    revertChanges(id, tabId) {
      patchTab(id, tabId, (t) => (t.kind === "table" ? { ...t, changes: emptyChanges() } : t));
    },

    addInsert(id, tabId, values) {
      patchTab(id, tabId, (t) => (t.kind === "table" ? { ...t, preview: false, changes: { ...t.changes, inserts: [{ values }, ...t.changes.inserts] } } : t));
    },

    updateInsert(id, tabId, index, column, value) {
      patchTab(id, tabId, (t) => {
        if (t.kind !== "table") return t;
        const inserts = t.changes.inserts.map((ins, i) => (i === index ? { values: { ...ins.values, [column]: value } } : ins));
        return { ...t, changes: { ...t.changes, inserts } };
      });
    },

    removeInsert(id, tabId, index) {
      patchTab(id, tabId, (t) => (t.kind === "table" ? { ...t, changes: { ...t.changes, inserts: t.changes.inserts.filter((_, i) => i !== index) } } : t));
    },

    toggleDelete(id, tabId, pk) {
      patchTab(id, tabId, (t) => {
        if (t.kind !== "table") return t;
        const key = pkKey(pk);
        const deletes = { ...t.changes.deletes };
        if (deletes[key]) delete deletes[key];
        else deletes[key] = { pk };
        return { ...t, preview: false, changes: { ...t.changes, deletes } };
      });
    },

    persist(id) {
      const w = ws(id);
      if (!w || !w.restored) return;
      const t = persistTimers.get(id);
      if (t) clearTimeout(t);
      persistTimers.set(
        id,
        setTimeout(() => {
          persistTimers.delete(id);
          const cur = get().byId[id];
          if (cur) flushPersist(cur);
        }, 500),
      );
    },
  };
});

function flushPersist(w: Workspace) {
  const value: PersistedWorkspace = { tabs: w.tabs, activeTabId: w.activeTabId, favorites: w.favorites, back: w.back.slice(-20), forward: w.forward.slice(-20), safeMode: w.safeMode };
  invoke("state_set", { key: stateKey(w.info), value: value as unknown as JsonValue }).catch(() => {});
}

/** Selectors */
export const useActiveWorkspace = () => useWorkspaces((s) => (s.activeId ? s.byId[s.activeId] : undefined));
export const useActiveTab = () =>
  useWorkspaces((s) => {
    const w = s.activeId ? s.byId[s.activeId] : undefined;
    return w?.tabs.find((t) => t.id === w.activeTabId);
  });
