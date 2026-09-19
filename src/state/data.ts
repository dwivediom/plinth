import { create } from "zustand";
import { errorMessage, invoke } from "../ipc/client";
import type { Cell, ColumnDesc, CursorId, ForeignKey, QueryError, QueryResult, TableSchema } from "../ipc/types";

export const WINDOW = 200;

export interface CursorRows {
  rows: Cell[][];
  exhausted: boolean;
  loading: boolean;
  error: string | null;
}

export interface TableData {
  schema: TableSchema | null;
  result: QueryResult | null;
  loading: boolean;
  error: string | null;
  exactCount: number | null;
  counting: boolean;
  loadedAt: number;
  /** Signature of the query the current result was opened with (filters/sort/limit). */
  sig: string;
}

export interface QueryRun {
  results: QueryResult[];
  active: number;
  running: boolean;
  error: QueryError | null;
  /** Offset in the editor text where the failing statement started. */
  errorBase: number;
  limitApplied: number | null;
  ranAt: number;
  totalMs: number;
}

/** What the inspector shows: the selected row of a tab, published by the grid that owns it. */
export interface SelectionInfo {
  columns: ColumnDesc[];
  values: Cell[];
  /** Original (unedited) values, same order as columns. */
  original: Cell[];
  editable: boolean;
  foreignKeys: ForeignKey[];
  onEdit?: (col: number, value: Cell) => void;
  onFollowFk?: (col: number) => void;
}

interface DataState {
  cursors: Record<CursorId, CursorRows>;
  tables: Record<string, TableData>;
  queries: Record<string, QueryRun>;
  selections: Record<string, SelectionInfo | null>;
  setSelection(tabId: string, sel: SelectionInfo | null): void;

  fetchMore(cursorId: CursorId): Promise<void>;
  ensureCursor(cursorId: CursorId): void;
  patchRow(cursorId: CursorId, index: number, row: Cell[]): void;
  setTable(tabId: string, patch: Partial<TableData>): void;
  setQuery(tabId: string, patch: Partial<QueryRun> | ((q: QueryRun | undefined) => Partial<QueryRun>)): void;
  dropTab(tabId: string): void;
  dropWorkspace(tabIds: string[]): void;
  /** Forget results (but keep schemas) so the tabs reopen their cursors, e.g. after a reconnect. */
  resetResults(tabIds: string[]): void;
}

const emptyTable = (): TableData => ({ schema: null, result: null, loading: false, error: null, exactCount: null, counting: false, loadedAt: 0, sig: "" });
const emptyQuery = (): QueryRun => ({ results: [], active: 0, running: false, error: null, errorBase: 0, limitApplied: null, ranAt: 0, totalMs: 0 });

const inflight = new Set<CursorId>();

export const useData = create<DataState>((set, get) => ({
  cursors: {},
  tables: {},
  queries: {},
  selections: {},

  setSelection(tabId, sel) {
    set((s) => ({ selections: { ...s.selections, [tabId]: sel } }));
  },

  ensureCursor(cursorId) {
    if (!get().cursors[cursorId]) {
      set((s) => ({ cursors: { ...s.cursors, [cursorId]: { rows: [], exhausted: false, loading: false, error: null } } }));
      void get().fetchMore(cursorId);
    }
  },

  async fetchMore(cursorId) {
    const cur = get().cursors[cursorId];
    if (!cur || cur.exhausted || inflight.has(cursorId)) return;
    inflight.add(cursorId);
    set((s) => ({ cursors: { ...s.cursors, [cursorId]: { ...s.cursors[cursorId], loading: true } } }));
    try {
      const win = await invoke("cursor_fetch", { cursorId, offset: cur.rows.length, len: WINDOW });
      set((s) => {
        const c = s.cursors[cursorId];
        if (!c) return s;
        const rows = win.offset === c.rows.length ? [...c.rows, ...win.rows] : c.rows;
        return { cursors: { ...s.cursors, [cursorId]: { rows, exhausted: win.exhausted || win.rows.length === 0, loading: false, error: null } } };
      });
    } catch (e) {
      set((s) => {
        const c = s.cursors[cursorId];
        if (!c) return s;
        return { cursors: { ...s.cursors, [cursorId]: { ...c, loading: false, exhausted: true, error: errorMessage(e) } } };
      });
    } finally {
      inflight.delete(cursorId);
    }
  },

  patchRow(cursorId, index, row) {
    set((s) => {
      const c = s.cursors[cursorId];
      if (!c) return s;
      const rows = [...c.rows];
      rows[index] = row;
      return { cursors: { ...s.cursors, [cursorId]: { ...c, rows } } };
    });
  },

  setTable(tabId, patch) {
    set((s) => ({ tables: { ...s.tables, [tabId]: { ...(s.tables[tabId] ?? emptyTable()), ...patch } } }));
  },

  setQuery(tabId, patch) {
    set((s) => {
      const prev = s.queries[tabId];
      const p = typeof patch === "function" ? patch(prev) : patch;
      return { queries: { ...s.queries, [tabId]: { ...(prev ?? emptyQuery()), ...p } } };
    });
  },

  dropTab(tabId) {
    const s = get();
    const t = s.tables[tabId];
    const q = s.queries[tabId];
    const cursorIds: CursorId[] = [];
    if (t?.result?.cursorId) cursorIds.push(t.result.cursorId);
    q?.results.forEach((r) => r.cursorId && cursorIds.push(r.cursorId));
    set((st) => {
      const tables = { ...st.tables };
      const queries = { ...st.queries };
      const cursors = { ...st.cursors };
      const selections = { ...st.selections };
      delete tables[tabId];
      delete queries[tabId];
      delete selections[tabId];
      cursorIds.forEach((c) => delete cursors[c]);
      return { tables, queries, cursors, selections };
    });
    cursorIds.forEach((c) => invoke("cursor_close", { cursorId: c }).catch(() => {}));
  },

  dropWorkspace(tabIds) {
    tabIds.forEach((id) => get().dropTab(id));
  },

  resetResults(tabIds) {
    set((st) => {
      const tables = { ...st.tables };
      const queries = { ...st.queries };
      for (const id of tabIds) {
        if (tables[id]) tables[id] = { ...tables[id], result: null, sig: "", error: null };
        if (queries[id]) queries[id] = { ...queries[id], results: [], error: null };
      }
      return { tables, queries };
    });
  },
}));

/** Drop a cursor's cached rows (e.g. before replacing it with a new result). */
export function releaseCursor(cursorId: CursorId | null | undefined) {
  if (!cursorId) return;
  useData.setState((s) => {
    const cursors = { ...s.cursors };
    delete cursors[cursorId];
    return { cursors };
  });
  invoke("cursor_close", { cursorId }).catch(() => {});
}
