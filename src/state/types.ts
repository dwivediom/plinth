import type { Cell, CellChange, ConnectionState, Filter, ObjectKind, RowInsert, SchemaIndex, Sort, TableRef, WorkspaceInfo } from "../ipc/types";
import type { OptimizeReport } from "../lib/optimize";

export type TabKind = "table" | "query" | "saved" | "map" | "chart" | "diff" | "plan" | "json";

interface TabBase {
  id: string;
  title: string;
  /** Italic, replaceable by the next single-click open. */
  preview: boolean;
}

export interface TabChanges {
  /** keyed by `${pkKey}\u0000${column}` */
  updates: Record<string, CellChange & { original: Cell }>;
  inserts: RowInsert[];
  /** keyed by pkKey */
  deletes: Record<string, { pk: Record<string, Cell> }>;
}

export interface TableTab extends TabBase {
  kind: "table";
  table: TableRef;
  objectKind: ObjectKind;
  view: "data" | "structure";
  filters: Filter[];
  sort: Sort[];
  scrollTop: number;
  hiddenColumns: string[];
  quickFilter: string;
  selectedRow: number | null;
  showFilterBar: boolean;
  /** Row limit for the data view; undefined = the default from Settings. */
  limit?: number | null;
  changes: TabChanges;
}

export interface QueryTab extends TabBase {
  kind: "query" | "saved";
  savedId: string | null;
  text: string;
  /** Text as last saved (or "" for a fresh query tab). */
  savedText: string;
  cursor: number;
  limit: number | null;
  /** Title was set by the user or a saved query; don't auto-title. */
  customTitle: boolean;
  selectedRow: number | null;
  /** Run once as soon as the view mounts — set when the AI pane opens a tab. */
  autoRun?: boolean;
  /** Provenance for the console: SQL a model wrote is logged as AI. */
  source?: "user" | "ai";
}

/** The schema map. One per workspace — opening it again focuses it. */
export interface MapTab extends TabBase {
  kind: "map";
  /** Narrows the map to matching tables and their immediate neighbours. */
  filter: string;
  /** The table the map is centred on, as `schema.table`. */
  focus: string | null;
}

/** A chart of one query's result. It owns its SQL so it survives the tab it
 *  came from, and can re-run itself. */
export interface ChartTab extends TabBase {
  kind: "chart";
  sql: string;
  form: ChartForm;
  /** Column names; null means "pick for me from the result". */
  x: string | null;
  y: string[] | null;
  /** The table view that the relief rule requires for low-contrast marks. */
  showTable: boolean;
}

export type ChartForm = "bar" | "line" | "area" | "scatter" | "donut";

/** A schema comparison between two open databases. */
export interface DiffTab extends TabBase {
  kind: "diff";
  /** The other side. The left side is always this tab's own workspace. */
  rightWorkspaceId: string | null;
}

/** A captured query plan. The JSON is stored on the tab: re-opening must
 *  never re-run the query, which with ANALYZE would execute it again. */
export interface PlanTab extends TabBase {
  kind: "plan";
  sql: string;
  planJson: string;
  analyzed: boolean;
  /** What the optimiser found, once it has been asked. */
  optimize?: OptimizeReport | null;
  optimizing?: string | null;
}

/**
 * A JSON document in its own tab: opened from a cell, or empty and pasted
 * into. It owns its text, so it survives the row it came from.
 */
export interface JsonTab extends TabBase {
  kind: "json";
  text: string;
  /** Where it came from — `orders.meta`, or null when it was pasted. */
  origin: string | null;
  /** The column, so a path can be copied as a SQL accessor. */
  sqlColumn: string | null;
  /** Editing the raw text rather than browsing the tree. */
  editing: boolean;
}

export type Tab = TableTab | QueryTab | MapTab | ChartTab | DiffTab | PlanTab | JsonTab;

export interface Workspace {
  info: WorkspaceInfo;
  schema: SchemaIndex | null;
  schemaLoading: boolean;
  schemaError: string | null;
  tabs: Tab[];
  activeTabId: string | null;
  back: string[];
  forward: string[];
  closed: Tab[];
  connState: ConnectionState;
  connDetail: string | null;
  openedAt: number;
  favorites: string[];
  safeMode: boolean;
  restored: boolean;
  runningTabs: Record<string, boolean>;
}

export const emptyChanges = (): TabChanges => ({ updates: {}, inserts: [], deletes: {} });

export function pkKey(pk: Record<string, Cell>): string {
  return JSON.stringify(Object.keys(pk).sort().map((k) => [k, pk[k]]));
}

export function changeCount(c: TabChanges): number {
  return Object.keys(c.updates).length + c.inserts.length + Object.keys(c.deletes).length;
}

/** Narrowing helper: the two tab kinds that carry SQL. */
export function isQueryTab(t: Tab): t is QueryTab {
  return t.kind === "query" || t.kind === "saved";
}

export function isTabDirty(t: Tab): boolean {
  if (t.kind === "table") return changeCount(t.changes) > 0;
  // Only the SQL-carrying kinds can be dirty; map, chart, diff and plan tabs
  // hold no unsaved work.
  if (!isQueryTab(t)) return false;
  return t.text.trim() !== t.savedText.trim();
}

export function tableKey(ref: TableRef): string {
  return `${ref.schema ?? ""}.${ref.name}`;
}

export function sameTable(a: TableRef, b: TableRef): boolean {
  return a.name === b.name && (a.schema ?? null) === (b.schema ?? null);
}

let seq = 0;
export function newId(prefix = "t"): string {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${seq.toString(36)}`;
}
