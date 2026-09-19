/**
 * IPC contract — mirrors crates/core/src/ipc.rs exactly.
 * If you change one, change the other.
 *
 * Wire rules: int64 / decimal / timestamps / bytes are STRINGS. Never call
 * Number() on a cell whose column `wire` is "string".
 */

export type ConnectionId = string;
export type WorkspaceId = string;
export type CursorId = string;

// ───────────────────────── connections ─────────────────────────

export type DriverKind = "postgres" | "mysql" | "sqlite";
export type Environment = "local" | "staging" | "production";
export type PolicyMode = "read-only" | "read-write" | "full";
export type SslMode = "prefer" | "disable" | "require";

export interface ConnectionProfile {
  id: ConnectionId;
  name: string;
  driver: DriverKind;
  environment: Environment;
  policy: PolicyMode;
  color?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  filePath?: string;
  ssl: SslMode;
  hasPassword: boolean;
  lastUsedAt?: string;
  favorite: boolean;
  folder?: string;
  /** Per-session statement timeout in ms; omitted or null means no limit. */
  statementTimeoutMs?: number | null;
}

export interface TestStage {
  name: string;
  ok: boolean;
  durationMs: number;
  error: string | null;
}
export interface TestReport {
  ok: boolean;
  stages: TestStage[];
  serverVersion: string | null;
}

// ───────────────────────── workspaces ─────────────────────────

export interface WorkspaceInfo {
  id: WorkspaceId;
  connectionId: ConnectionId;
  connectionName: string;
  driver: DriverKind;
  environment: Environment;
  policy: PolicyMode;
  database: string;
  databases: string[];
  serverVersion: string | null;
  tls: boolean;
}

// ───────────────────────── schema ─────────────────────────

export type ObjectKind = "table" | "view" | "materialized-view" | "function" | "sequence";

export interface SchemaIndex {
  schemas: SchemaInfo[];
  columns: ColumnRef[];
  generatedAt: string;
}
export interface SchemaInfo {
  name: string;
  isSystem: boolean;
  objects: ObjectInfo[];
}
export interface ObjectInfo {
  schema: string;
  name: string;
  kind: ObjectKind;
  rowEstimate: number | null;
}
export interface ColumnRef {
  schema: string;
  table: string;
  column: string;
}
export interface ColumnSnapshot {
  name: string;
  dataType: string;
  nullable: boolean;
  default: string | null;
  ordinal: number;
}
export interface IndexSnapshot { name: string; definition: string; unique: boolean }

/** Which side of a comparison something lives on. `added` means the migration
 *  must add it to the right-hand database. */
export type DiffStatus = "added" | "removed" | "changed" | "same";

export interface ColumnDiff {
  name: string;
  status: DiffStatus;
  left: ColumnSnapshot | null;
  right: ColumnSnapshot | null;
  /** "type", "nullability", "default" */
  changes: string[];
}
export interface IndexDiff { name: string; status: DiffStatus; left: IndexSnapshot | null; right: IndexSnapshot | null }
export interface TableDiff {
  table: TableRef;
  kind: ObjectKind;
  status: DiffStatus;
  columns: ColumnDiff[];
  indexes: IndexDiff[];
  primaryKeyChanged: boolean;
}
export interface DiffSummary {
  tablesAdded: number;
  tablesRemoved: number;
  tablesChanged: number;
  columnsAdded: number;
  columnsRemoved: number;
  columnsChanged: number;
}
export interface SchemaDiff {
  tables: TableDiff[];
  leftLabel: string;
  rightLabel: string;
  summary: DiffSummary;
}

/** One relationship in the schema map. `inferred` edges are a naming-and-type
 *  guess, never a declared constraint — the UI and the model are both told. */
export interface GraphEdge {
  from: TableRef;
  fromColumns: string[];
  to: TableRef;
  toColumns: string[];
  name: string | null;
  inferred: boolean;
}
export interface GraphNode {
  table: TableRef;
  kind: ObjectKind;
  columns: string[];
  rowEstimate: number | null;
}
export interface SchemaGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  generatedAt: string;
}

export interface TableRef {
  schema: string | null;
  name: string;
}

export type LogicalType =
  | "bool" | "int" | "float" | "decimal" | "text" | "bytes" | "json"
  | "timestamp" | "date" | "time" | "uuid" | "array" | "document"
  /** pgvector `vector`/`halfvec`/`sparsevec`, carried as `[0.1,-0.2,…]`. */
  | "vector"
  | "unknown";
export type WireKind = "bool" | "number" | "string" | "json";

export const isNumericType = (t: LogicalType) => t === "int" || t === "float" || t === "decimal";

export interface ColumnDesc {
  name: string;
  dataType: string;
  logical: LogicalType;
  wire: WireKind;
  nullable: boolean | null;
  table?: TableRef;
}

export interface TableSchema {
  table: TableRef;
  kind: ObjectKind;
  columns: ColumnInfo[];
  primaryKey: string[];
  foreignKeys: ForeignKey[];
  indexes: IndexInfo[];
  ddl: string | null;
  rowEstimate: number | null;
}
export interface ColumnInfo {
  name: string;
  dataType: string;
  logical: LogicalType;
  nullable: boolean;
  default: string | null;
  isPrimaryKey: boolean;
  ordinal: number;
}
export interface ForeignKey {
  name: string | null;
  columns: string[];
  refTable: TableRef;
  refColumns: string[];
}
export interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
}

// ───────────────────────── data ─────────────────────────

export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };
export type Cell = JsonValue;

export interface RowWindow {
  cursorId: CursorId;
  offset: number;
  rows: Cell[][];
  buffered: number;
  truncated: boolean;
  exhausted: boolean;
}

export type StatementKind = "select" | "insert" | "update" | "delete" | "ddl" | "other";

export interface QueryError {
  message: string;
  line: number | null;
  column: number | null;
  code: string | null;
  blockedByPolicy: boolean;
}

export interface QueryResult {
  statement: string;
  kind: StatementKind;
  columns: ColumnDesc[];
  cursorId: CursorId | null;
  rowCount: number | null;
  rowsAffected: number | null;
  truncated: boolean;
  durationMs: number;
  error: QueryError | null;
}

export type SortDir = "asc" | "desc";
export interface Sort { column: string; dir: SortDir }
export type FilterOp =
  | "eq" | "neq" | "lt" | "lte" | "gt" | "gte" | "like" | "not-like" | "in" | "is-null" | "is-not-null";
export interface Filter { column: string; op: FilterOp; value: string | null }
export interface TableQuery {
  filters: Filter[];
  sort: Sort[];
  limit: number | null;
  offset: number | null;
}

// ───────────────────────── policy dry run ─────────────────────────

export interface StatementCheck {
  sql: string;
  kind: StatementKind;
  /** `false` when sqlparser couldn't parse it — never run those silently. */
  parsed: boolean;
  /** `false` for an UPDATE/DELETE with no WHERE. */
  hasWhere: boolean | null;
  isExplain: boolean;
  allowed: boolean;
  blockedReason: string | null;
}
export interface SqlCheck {
  statements: StatementCheck[];
  readOnly: boolean;
  allowed: boolean;
  policy: PolicyMode;
}

// ───────────────────────── editing ─────────────────────────

export interface CellChange { pk: Record<string, Cell>; column: string; value: Cell }
export interface RowInsert { values: Record<string, Cell> }
export interface RowDelete { pk: Record<string, Cell> }
export interface ChangeSet {
  table: TableRef | null;
  updates: CellChange[];
  inserts: RowInsert[];
  deletes: RowDelete[];
}
export interface ChangePreview { statements: string[]; affectedEstimate: number }
export interface ChangeOutcome { statements: string[]; rowsAffected: number; durationMs: number }

// ───────────────────────── console / history / saved ─────────────────────────

export type ConsoleSource = "app" | "user" | "ai";
export interface ConsoleEntry {
  id: number;
  workspaceId: WorkspaceId | null;
  connectionId: ConnectionId;
  source: ConsoleSource;
  sql: string;
  durationMs: number;
  rows: number | null;
  error: string | null;
  at: string;
}
export interface SavedQuery {
  id: string;
  connectionId: ConnectionId | null;
  name: string;
  folder: string | null;
  sql: string;
  updatedAt: string;
}

// ───────────────────────── events ─────────────────────────

export type ConnectionState = "connecting" | "up" | "degraded" | "down";
export type EngineEvent =
  | { type: "connection-state"; workspaceId: WorkspaceId; state: ConnectionState; detail: string | null }
  | { type: "console-appended"; entry: ConsoleEntry }
  | { type: "schema-changed"; workspaceId: WorkspaceId };

export const ENGINE_EVENT = "plinth://event";

// ───────────────────────── errors ─────────────────────────

export interface IpcError {
  code: "not-found" | "policy" | "driver" | "io" | "invalid" | "internal" | string;
  message: string;
  detail?: string;
}

// ───────────────────────── ai setup ─────────────────────────
// Shell-only, like `sqlite_pick_file` — the mirror of these lives in
// `src-tauri/src/ai.rs`, not in the engine contract.

export interface HardwareInfo {
  os: string;
  arch: string;
  chip: string;
  cpuCores: number;
  memoryGb: number;
  unifiedMemory: boolean;
  /** What we'll promise a model: ~75% of unified memory, else RAM less 4 GB. */
  usableModelGb: number;
}
export interface OllamaModel { name: string; sizeGb: number; parameterSize: string | null; quantization: string | null }
export interface OllamaInfo {
  installed: boolean;
  running: boolean;
  version: string | null;
  endpoint: string;
  binaryPath: string | null;
  models: OllamaModel[];
}
export interface ModelOption {
  name: string;
  label: string;
  paramsB: number;
  downloadGb: number;
  needsGb: number;
  fits: boolean;
  installed: boolean;
  note: string;
}
export interface McpClientInfo { id: string; name: string; configPath: string | null; available: boolean; registered: boolean }
export interface McpInfo { built: boolean; binaryPath: string | null; buildable: boolean; clients: McpClientInfo[] }
export interface PullState { model: string; done: boolean; ok: boolean; message: string }
export interface AiStatus {
  hardware: HardwareInfo;
  ollama: OllamaInfo;
  mcp: McpInfo;
  models: ModelOption[];
  pulling: PullState | null;
}
export interface AiActionResult { ok: boolean; message: string }
export interface ChatTurn { role: "user" | "assistant"; content: string }
/** One move in the agent loop. The harness owns the loop; this is the model's
 *  proposal for what to do next. */
export interface AiStep {
  thought: string;
  action: "inspect" | "sample" | "probe" | "answer";
  table: string | null;
  sql: string | null;
  answer: string | null;
  tables: string[];
  assumptions: string[];
  durationMs: number;
}
export interface AiAnswer {
  /** Prose only — the model is told never to put SQL in here. */
  text: string;
  /** Exactly one statement, or null when the question wasn't about data. */
  sql: string | null;
  /** Tables the answer leans on, as `schema.table`. */
  tables: string[];
  durationMs: number;
}

// ───────────────────────── command catalogue ─────────────────────────

export interface Commands {
  connections_list(args: Record<string, never>): Promise<ConnectionProfile[]>;
  connections_save(args: { profile: ConnectionProfile; password?: string | null }): Promise<ConnectionProfile>;
  connections_delete(args: { id: ConnectionId }): Promise<void>;
  connection_test(args: { profile: ConnectionProfile; password?: string | null }): Promise<TestReport>;
  workspace_open(args: { connectionId: ConnectionId; database?: string | null }): Promise<WorkspaceInfo>;
  workspace_close(args: { workspaceId: WorkspaceId }): Promise<void>;
  /** Open another window, optionally straight onto a connection. Returns its label. */
  window_open(args: { open: string | null; database: string | null; from: string | null }): Promise<string>;
  /** Bring a window forward. False when that window has gone. */
  window_focus(args: { label: string }): Promise<boolean>;
  /** The labels of the windows this process has open. */
  window_list(args: Record<string, never>): Promise<string[]>;
  /** The toolbar padlock — enforced in the engine, not just drawn in the UI. */
  workspace_set_safe_mode(args: { workspaceId: WorkspaceId; on: boolean }): Promise<void>;
  workspace_list(args: Record<string, never>): Promise<WorkspaceInfo[]>;
  schema_index(args: { workspaceId: WorkspaceId; refresh: boolean }): Promise<SchemaIndex>;
  schema_graph(args: { workspaceId: WorkspaceId; refresh: boolean }): Promise<SchemaGraph>;
  schema_diff(args: { leftWorkspaceId: WorkspaceId; rightWorkspaceId: WorkspaceId }): Promise<SchemaDiff>;
  migration_sql(args: { workspaceId: WorkspaceId; diff: SchemaDiff }): Promise<string>;
  table_describe(args: { workspaceId: WorkspaceId; table: TableRef }): Promise<TableSchema>;
  table_open(args: { workspaceId: WorkspaceId; table: TableRef; query: TableQuery }): Promise<QueryResult>;
  table_count(args: { workspaceId: WorkspaceId; table: TableRef; exact: boolean }): Promise<number>;
  query_run(args: { workspaceId: WorkspaceId; sql: string; limit?: number | null; source?: "user" | "ai" }): Promise<QueryResult[]>;
  /**
   * One statement, run as if the connection's policy were `full`.
   *
   * Refused outright on a read-only connection and while safe mode is on, and
   * never remembered — it is the escape hatch behind "blocked by read-write
   * policy", not a way to turn the policy off.
   */
  query_run_elevated(args: { workspaceId: WorkspaceId; sql: string; limit: number | null }): Promise<QueryResult[]>;
  sql_check(args: { workspaceId: WorkspaceId; sql: string }): Promise<SqlCheck>;
  /** Plan a read-only statement with hypothetical indexes in place, on one
   *  connection. Returns the plan as JSON. Postgres + hypopg only. */
  explain_hypothetical(args: { workspaceId: WorkspaceId; sql: string; indexes: string[] }): Promise<string>;
  query_cancel(args: { workspaceId: WorkspaceId }): Promise<void>;
  cursor_fetch(args: { cursorId: CursorId; offset: number; len: number }): Promise<RowWindow>;
  cursor_close(args: { cursorId: CursorId }): Promise<void>;
  changes_preview(args: { workspaceId: WorkspaceId; changes: ChangeSet }): Promise<ChangePreview>;
  changes_apply(args: { workspaceId: WorkspaceId; changes: ChangeSet }): Promise<ChangeOutcome>;
  console_list(args: { workspaceId?: WorkspaceId | null; limit: number }): Promise<ConsoleEntry[]>;
  history_list(args: { connectionId: ConnectionId; limit: number }): Promise<ConsoleEntry[]>;
  saved_list(args: { connectionId?: ConnectionId | null }): Promise<SavedQuery[]>;
  saved_save(args: { query: SavedQuery }): Promise<SavedQuery>;
  saved_delete(args: { id: string }): Promise<void>;
  state_get(args: { key: string }): Promise<JsonValue>;
  state_set(args: { key: string; value: JsonValue }): Promise<void>;
  sqlite_pick_file(args: Record<string, never>): Promise<string | null>;
  ai_probe(args: Record<string, never>): Promise<AiStatus>;
  ai_ollama_install(args: Record<string, never>): Promise<AiActionResult>;
  ai_ollama_start(args: Record<string, never>): Promise<AiActionResult>;
  ai_model_pull(args: { model: string }): Promise<AiActionResult>;
  ai_mcp_connect(args: { client: string }): Promise<AiActionResult>;
  ai_ask(args: { model: string; prompt: string; context: string; history: ChatTurn[] }): Promise<AiAnswer>;
  ai_step(args: { model: string; context: string; history: ChatTurn[] }): Promise<AiStep>;
}
export type CommandName = keyof Commands;
