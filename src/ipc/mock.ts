/**
 * In-memory fake backend. Implements every command in `Commands` with
 * deterministic sample data so the app runs fully in a plain browser.
 */
import type {
  Cell,
  ChangeOutcome,
  ChangeSet,
  ColumnDesc,
  ColumnInfo,
  AiActionResult,
  AiAnswer,
  AiStep,
  AiStatus,
  Commands,
  ConnectionProfile,
  ConsoleEntry,
  ConnectionId,
  EngineEvent,
  Filter,
  ForeignKey,
  IndexInfo,
  JsonValue,
  LogicalType,
  ObjectKind,
  QueryError,
  QueryResult,
  RowWindow,
  SavedQuery,
  SchemaDiff,
  SchemaGraph,
  SchemaIndex,
  Sort,
  SqlCheck,
  StatementKind,
  TableRef,
  TableSchema,
  TestReport,
  WireKind,
  WorkspaceInfo,
  WorkspaceId,
} from "./types";

// ───────────────────────── utilities ─────────────────────────

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const latency = () => delay(30 + Math.floor(Math.random() * 90));

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
function isoAt(base: number, offsetSec: number) {
  const d = new Date(base + offsetSec * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+00`;
}
function dateAt(base: number, offsetSec: number) {
  const d = new Date(base + offsetSec * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

const BASE_TS = Date.UTC(2026, 2, 4, 9, 12, 44);

// ───────────────────────── event emitter ─────────────────────────

type Listener = (ev: EngineEvent) => void;
const listeners = new Set<Listener>();
export const mockEmitter = {
  subscribe(cb: Listener) {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  },
  emit(ev: EngineEvent) {
    for (const l of Array.from(listeners)) {
      try {
        l(ev);
      } catch (e) {
        console.error(e);
      }
    }
  },
};

// ───────────────────────── local storage ─────────────────────────

function lsGet<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}
function lsSet(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode, quota… ignore */
  }
}

// ───────────────────────── connections ─────────────────────────

const now = Date.now();
const defaultConnections: ConnectionProfile[] = [
  {
    id: "c_prod",
    name: "prod-rds",
    driver: "postgres",
    environment: "production",
    policy: "read-only",
    host: "mydb.abc.us-east-1.rds.amazonaws.com",
    port: 5432,
    database: "app",
    user: "readonly",
    ssl: "require",
    hasPassword: true,
    lastUsedAt: new Date(now - 2 * 60_000).toISOString(),
    favorite: true,
  },
  {
    id: "c_staging",
    name: "staging-db",
    driver: "postgres",
    environment: "staging",
    policy: "read-write",
    host: "staging.internal",
    port: 5432,
    database: "app",
    user: "app",
    ssl: "prefer",
    hasPassword: true,
    lastUsedAt: new Date(now - 26 * 3_600_000).toISOString(),
    favorite: false,
  },
  {
    id: "c_sqlite",
    name: "analytics.db",
    driver: "sqlite",
    environment: "local",
    policy: "full",
    filePath: "~/Data/analytics.db",
    ssl: "disable",
    hasPassword: false,
    favorite: false,
  },
];
let connections: ConnectionProfile[] = lsGet<ConnectionProfile[]>("plinth:mock:connections", defaultConnections);
const persistConnections = () => lsSet("plinth:mock:connections", connections);

const databasesFor = (c: ConnectionProfile): string[] => {
  if (c.driver === "sqlite") return ["main"];
  if (c.id === "c_prod") return ["app", "analytics", "billing", "warehouse"];
  if (c.id === "c_staging") return ["app", "analytics"];
  return [c.database ?? "postgres", "postgres"];
};

// ───────────────────────── table definitions ─────────────────────────

interface ColDef {
  name: string;
  dataType: string;
  logical: LogicalType;
  wire: WireKind;
  nullable: boolean;
  default?: string | null;
  pk?: boolean;
}
interface TableDef {
  schema: string;
  name: string;
  kind: ObjectKind;
  columns: ColDef[];
  rowEstimate: number | null;
  count: number;
  gen: (i: number, rnd: () => number) => Cell[];
  foreignKeys?: ForeignKey[];
  indexes?: IndexInfo[];
}
interface MockTable {
  def: TableDef;
  rows: Cell[][];
}

const customers = ["acme", "globex", "initech", "umbrella", "stark", "wayne", "hooli", "vehement", "wonka", "tyrell", "soylent", "cyberdyne"];
const statuses = ["paid", "paid", "paid", "pending", "refunded", "failed"];
const tiers = ["gold", "silver", "bronze"];
const notes = ["", "call back", "gift wrap", "priority", "hold at depot", "", "", "fragile"];
const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet"];

function bigId(i: number) {
  // ids that cross Number.MAX_SAFE_INTEGER — always strings on the wire
  return (9007199254740993n + BigInt(i)).toString();
}

const orderColumns: ColDef[] = [
  { name: "id", dataType: "bigint", logical: "int", wire: "string", nullable: false, default: "nextval('orders_id_seq')", pk: true },
  { name: "customer", dataType: "text", logical: "text", wire: "string", nullable: false },
  { name: "amount", dataType: "numeric(19,4)", logical: "decimal", wire: "string", nullable: false, default: "0" },
  { name: "status", dataType: "text", logical: "text", wire: "string", nullable: false, default: "'pending'" },
  { name: "payment_id", dataType: "integer", logical: "int", wire: "number", nullable: true },
  { name: "note", dataType: "text", logical: "text", wire: "string", nullable: true },
  { name: "meta", dataType: "jsonb", logical: "json", wire: "json", nullable: true },
  { name: "shipped", dataType: "boolean", logical: "bool", wire: "bool", nullable: false, default: "false" },
  { name: "created_at", dataType: "timestamptz", logical: "timestamp", wire: "string", nullable: false, default: "now()" },
];

const pgAppTables: TableDef[] = [
  {
    schema: "public",
    name: "orders",
    kind: "table",
    columns: orderColumns,
    rowEstimate: 4_200_000,
    count: 5000,
    gen: (i, rnd) => {
      const cents = Math.floor(rnd() * 5_000_000);
      const amount = i === 0 ? "10000000000000.0001" : `${Math.floor(cents / 100)}.${pad(cents % 100)}00`;
      const status = statuses[Math.floor(rnd() * statuses.length)];
      const note = notes[Math.floor(rnd() * notes.length)];
      return [
        bigId(i),
        customers[Math.floor(rnd() * customers.length)],
        amount,
        status,
        rnd() < 0.9 ? 1 + Math.floor(rnd() * 500) : null,
        note === "" ? null : note,
        rnd() < 0.7 ? { tier: tiers[Math.floor(rnd() * 3)], items: 1 + Math.floor(rnd() * 5), tags: [words[i % 10]] } : null,
        status === "paid" && rnd() < 0.8,
        isoAt(BASE_TS, -i * 733),
      ];
    },
    foreignKeys: [{ name: "orders_payment_id_fkey", columns: ["payment_id"], refTable: { schema: "public", name: "payments" }, refColumns: ["id"] }],
    indexes: [
      { name: "orders_pkey", columns: ["id"], unique: true, primary: true },
      { name: "orders_customer_idx", columns: ["customer"], unique: false, primary: false },
      { name: "orders_created_at_idx", columns: ["created_at"], unique: false, primary: false },
    ],
  },
  {
    schema: "public",
    name: "users",
    kind: "table",
    columns: [
      { name: "id", dataType: "integer", logical: "int", wire: "number", nullable: false, pk: true, default: "nextval('users_id_seq')" },
      { name: "email", dataType: "text", logical: "text", wire: "string", nullable: false },
      { name: "name", dataType: "text", logical: "text", wire: "string", nullable: true },
      { name: "uid", dataType: "uuid", logical: "uuid", wire: "string", nullable: false, default: "gen_random_uuid()" },
      { name: "active", dataType: "boolean", logical: "bool", wire: "bool", nullable: false, default: "true" },
      { name: "score", dataType: "double precision", logical: "float", wire: "number", nullable: true },
      { name: "signed_up", dataType: "date", logical: "date", wire: "string", nullable: false },
    ],
    rowEstimate: 18_000,
    count: 300,
    gen: (i, rnd) => [
      i + 1,
      `${words[i % 10]}${i}@example.com`,
      rnd() < 0.9 ? `${words[(i * 7) % 10]} ${words[(i * 3) % 10]}` : null,
      `${Math.floor(rnd() * 0xffffffff).toString(16).padStart(8, "0")}-4b2e-4c1a-9d${pad(i % 100)}-${Math.floor(rnd() * 0xffffffffffff).toString(16).padStart(12, "0")}`,
      rnd() < 0.85,
      rnd() < 0.7 ? Math.round(rnd() * 10000) / 100 : null,
      dateAt(BASE_TS, -i * 86_400 * 3),
    ],
    indexes: [
      { name: "users_pkey", columns: ["id"], unique: true, primary: true },
      { name: "users_email_key", columns: ["email"], unique: true, primary: false },
    ],
  },
  {
    schema: "public",
    name: "payments",
    kind: "table",
    columns: [
      { name: "id", dataType: "integer", logical: "int", wire: "number", nullable: false, pk: true },
      { name: "method_id", dataType: "integer", logical: "int", wire: "number", nullable: false },
      { name: "amount", dataType: "numeric(19,4)", logical: "decimal", wire: "string", nullable: false },
      { name: "currency", dataType: "char(3)", logical: "text", wire: "string", nullable: false, default: "'USD'" },
      { name: "captured", dataType: "boolean", logical: "bool", wire: "bool", nullable: false, default: "false" },
      { name: "captured_at", dataType: "timestamptz", logical: "timestamp", wire: "string", nullable: true },
    ],
    rowEstimate: 312_000,
    count: 500,
    gen: (i, rnd) => {
      const captured = rnd() < 0.8;
      return [i + 1, 1 + Math.floor(rnd() * 6), `${Math.floor(rnd() * 20000)}.${pad(Math.floor(rnd() * 100))}00`, rnd() < 0.8 ? "USD" : "EUR", captured, captured ? isoAt(BASE_TS, -i * 1811) : null];
    },
    foreignKeys: [{ name: "payments_method_id_fkey", columns: ["method_id"], refTable: { schema: "public", name: "payment_methods" }, refColumns: ["id"] }],
    indexes: [{ name: "payments_pkey", columns: ["id"], unique: true, primary: true }],
  },
  {
    schema: "public",
    name: "payment_methods",
    kind: "table",
    columns: [
      { name: "id", dataType: "integer", logical: "int", wire: "number", nullable: false, pk: true },
      { name: "kind", dataType: "text", logical: "text", wire: "string", nullable: false },
      { name: "label", dataType: "text", logical: "text", wire: "string", nullable: true },
    ],
    rowEstimate: 6,
    count: 6,
    gen: (i) => [i + 1, ["card", "card", "bank", "wallet", "invoice", "crypto"][i], ["Visa", "Mastercard", "ACH", "Apple Pay", "Net 30", "USDC"][i]],
    indexes: [{ name: "payment_methods_pkey", columns: ["id"], unique: true, primary: true }],
  },
  {
    schema: "public",
    name: "refunds",
    kind: "table",
    columns: [
      { name: "id", dataType: "integer", logical: "int", wire: "number", nullable: false, pk: true },
      { name: "order_id", dataType: "bigint", logical: "int", wire: "string", nullable: false },
      { name: "amount", dataType: "numeric(19,4)", logical: "decimal", wire: "string", nullable: false },
      { name: "reason", dataType: "text", logical: "text", wire: "string", nullable: true },
      { name: "created_at", dataType: "timestamptz", logical: "timestamp", wire: "string", nullable: false, default: "now()" },
    ],
    rowEstimate: 80,
    count: 80,
    gen: (i, rnd) => [i + 1, bigId(Math.floor(rnd() * 5000)), `${Math.floor(rnd() * 300)}.0000`, rnd() < 0.5 ? ["damaged", "late", "wrong item", "changed mind"][i % 4] : null, isoAt(BASE_TS, -i * 9000)],
    foreignKeys: [{ name: "refunds_order_id_fkey", columns: ["order_id"], refTable: { schema: "public", name: "orders" }, refColumns: ["id"] }],
    indexes: [{ name: "refunds_pkey", columns: ["id"], unique: true, primary: true }],
  },
  {
    schema: "public",
    name: "audit_log",
    kind: "table",
    columns: [
      { name: "at", dataType: "timestamptz", logical: "timestamp", wire: "string", nullable: false },
      { name: "actor", dataType: "text", logical: "text", wire: "string", nullable: true },
      { name: "action", dataType: "text", logical: "text", wire: "string", nullable: false },
      { name: "payload", dataType: "jsonb", logical: "json", wire: "json", nullable: true },
    ],
    rowEstimate: 200,
    count: 200,
    gen: (i, rnd) => [isoAt(BASE_TS, -i * 300), rnd() < 0.8 ? words[i % 10] : null, ["login", "update", "delete", "export"][i % 4], { ip: `10.0.${i % 255}.${(i * 7) % 255}` }],
  },
  {
    schema: "billing",
    name: "payout_batches",
    kind: "table",
    columns: [
      { name: "id", dataType: "integer", logical: "int", wire: "number", nullable: false, pk: true },
      { name: "day", dataType: "date", logical: "date", wire: "string", nullable: false },
      { name: "total", dataType: "numeric(19,4)", logical: "decimal", wire: "string", nullable: false },
      { name: "settled", dataType: "boolean", logical: "bool", wire: "bool", nullable: false, default: "false" },
    ],
    rowEstimate: 120,
    count: 120,
    gen: (i, rnd) => [i + 1, dateAt(BASE_TS, -i * 86_400), `${Math.floor(rnd() * 900000)}.${pad(Math.floor(rnd() * 100))}00`, i > 2],
    indexes: [{ name: "payout_batches_pkey", columns: ["id"], unique: true, primary: true }],
  },
  {
    schema: "billing",
    name: "v_payouts_daily",
    kind: "view",
    columns: [
      { name: "day", dataType: "date", logical: "date", wire: "string", nullable: true },
      { name: "payouts", dataType: "bigint", logical: "int", wire: "string", nullable: true },
      { name: "total", dataType: "numeric", logical: "decimal", wire: "string", nullable: true },
    ],
    rowEstimate: null,
    count: 120,
    gen: (i, rnd) => [dateAt(BASE_TS, -i * 86_400), String(Math.floor(rnd() * 400)), `${Math.floor(rnd() * 900000)}.${pad(Math.floor(rnd() * 100))}`],
  },
  {
    schema: "billing",
    name: "next_payout",
    kind: "function",
    columns: [],
    rowEstimate: null,
    count: 0,
    gen: () => [],
  },
  {
    schema: "public",
    name: "orders_id_seq",
    kind: "sequence",
    columns: [],
    rowEstimate: null,
    count: 0,
    gen: () => [],
  },
];

const pgAnalyticsTables: TableDef[] = [
  {
    schema: "public",
    name: "events",
    kind: "table",
    columns: [
      { name: "id", dataType: "bigint", logical: "int", wire: "string", nullable: false, pk: true },
      { name: "name", dataType: "text", logical: "text", wire: "string", nullable: false },
      { name: "user_id", dataType: "integer", logical: "int", wire: "number", nullable: true },
      { name: "props", dataType: "jsonb", logical: "json", wire: "json", nullable: true },
      // pgvector, so the browser build exercises the embedding path too.
      { name: "embedding", dataType: "vector(384)", logical: "vector", wire: "string", nullable: true },
      { name: "at", dataType: "timestamptz", logical: "timestamp", wire: "string", nullable: false },
    ],
    rowEstimate: 96_000_000,
    count: 2000,
    gen: (i, rnd) => [
      String(1_000_000 + i),
      ["page_view", "click", "purchase", "signup"][Math.floor(rnd() * 4)],
      Math.floor(rnd() * 18000),
      { path: `/${words[i % 10]}` },
      `[${Array.from({ length: 384 }, () => (rnd() * 2 - 1).toFixed(4)).join(",")}]`,
      isoAt(BASE_TS, -i * 5),
    ],
    indexes: [{ name: "events_pkey", columns: ["id"], unique: true, primary: true }],
  },
  {
    schema: "public",
    name: "sessions",
    kind: "table",
    columns: [
      { name: "id", dataType: "uuid", logical: "uuid", wire: "string", nullable: false, pk: true },
      { name: "user_id", dataType: "integer", logical: "int", wire: "number", nullable: true },
      { name: "started_at", dataType: "timestamptz", logical: "timestamp", wire: "string", nullable: false },
      { name: "duration_s", dataType: "integer", logical: "int", wire: "number", nullable: true },
    ],
    rowEstimate: 2_400_000,
    count: 800,
    gen: (i, rnd) => [`5f1c${pad(i, 4)}-1a2b-4c3d-8e9f-${pad(Math.floor(rnd() * 1e12), 12)}`, Math.floor(rnd() * 18000), isoAt(BASE_TS, -i * 61), Math.floor(rnd() * 3600)],
    indexes: [{ name: "sessions_pkey", columns: ["id"], unique: true, primary: true }],
  },
];

const sqliteTables: TableDef[] = [
  {
    schema: "main",
    name: "events",
    kind: "table",
    columns: [
      { name: "id", dataType: "INTEGER", logical: "int", wire: "number", nullable: false, pk: true },
      { name: "name", dataType: "TEXT", logical: "text", wire: "string", nullable: false },
      { name: "value", dataType: "REAL", logical: "float", wire: "number", nullable: true },
      { name: "at", dataType: "TEXT", logical: "timestamp", wire: "string", nullable: false },
    ],
    rowEstimate: 1200,
    count: 1200,
    gen: (i, rnd) => [i + 1, ["open", "close", "sync"][i % 3], rnd() < 0.8 ? Math.round(rnd() * 1000) / 10 : null, isoAt(BASE_TS, -i * 120)],
    indexes: [{ name: "sqlite_autoindex_events_1", columns: ["id"], unique: true, primary: true }],
  },
  {
    schema: "main",
    name: "page_views",
    kind: "table",
    columns: [
      { name: "id", dataType: "INTEGER", logical: "int", wire: "number", nullable: false, pk: true },
      { name: "path", dataType: "TEXT", logical: "text", wire: "string", nullable: false },
      { name: "ms", dataType: "INTEGER", logical: "int", wire: "number", nullable: true },
    ],
    rowEstimate: 340,
    count: 340,
    gen: (i, rnd) => [i + 1, `/${words[i % 10]}/${words[(i * 3) % 10]}`, Math.floor(rnd() * 900)],
    indexes: [{ name: "sqlite_autoindex_page_views_1", columns: ["id"], unique: true, primary: true }],
  },
];

function materialise(defs: TableDef[], seed: number): Map<string, MockTable> {
  const m = new Map<string, MockTable>();
  for (const def of defs) {
    const rnd = mulberry32(seed + def.name.length * 131 + def.schema.length);
    const rows: Cell[][] = [];
    for (let i = 0; i < def.count; i++) rows.push(def.gen(i, rnd));
    m.set(`${def.schema}.${def.name}`, { def, rows });
  }
  return m;
}

/** database catalogue keyed by `${connectionId}/${database}` — materialised lazily */
const catalogue = new Map<string, Map<string, MockTable>>();
function tablesFor(connectionId: ConnectionId, database: string): Map<string, MockTable> {
  const key = `${connectionId}/${database}`;
  let m = catalogue.get(key);
  if (m) return m;
  const conn = connections.find((c) => c.id === connectionId);
  const seed = connectionId === "c_prod" ? 7 : connectionId === "c_staging" ? 11 : 13;
  if (conn?.driver === "sqlite") m = materialise(sqliteTables, seed);
  else if (database === "analytics") m = materialise(pgAnalyticsTables, seed);
  else if (database === "app") m = materialise(pgAppTables, seed);
  else m = materialise(pgAppTables.filter((t) => t.schema === "billing"), seed);
  catalogue.set(key, m);
  return m;
}

function resolveTable(tables: Map<string, MockTable>, ref: TableRef): MockTable | null {
  if (ref.schema) return tables.get(`${ref.schema}.${ref.name}`) ?? null;
  for (const [, t] of tables) if (t.def.name === ref.name && (t.def.schema === "public" || t.def.schema === "main")) return t;
  for (const [, t] of tables) if (t.def.name === ref.name) return t;
  return null;
}

const colDesc = (c: ColDef, table?: TableRef): ColumnDesc => ({ name: c.name, dataType: c.dataType, logical: c.logical, wire: c.wire, nullable: c.nullable, table });

// ───────────────────────── workspaces ─────────────────────────

interface MockWorkspace {
  info: WorkspaceInfo;
  /** The padlock, as the engine holds it — see `Workspace::safe_mode`. */
  safeMode: boolean;
}
const workspaces = new Map<WorkspaceId, MockWorkspace>();
let wsSeq = 1;
let cursorSeq = 1;
let consoleSeq = 1;

const cursors = new Map<string, { rows: Cell[][] }>();

const consoleEntries: ConsoleEntry[] = [
  {
    id: consoleSeq++,
    workspaceId: null,
    connectionId: "c_prod",
    source: "ai",
    sql: "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'orders'",
    durationMs: 3,
    rows: 9,
    error: null,
    at: new Date(now - 40 * 60_000).toISOString(),
  },
  {
    id: consoleSeq++,
    workspaceId: null,
    connectionId: "c_prod",
    source: "ai",
    sql: "SELECT status, count(*) FROM public.orders GROUP BY 1 ORDER BY 2 DESC",
    durationMs: 412,
    rows: 4,
    error: null,
    at: new Date(now - 39 * 60_000).toISOString(),
  },
  {
    id: consoleSeq++,
    workspaceId: null,
    connectionId: "c_prod",
    source: "user",
    sql: "select * from orders where status = 'paid' limit 100",
    durationMs: 38,
    rows: 100,
    error: null,
    at: new Date(now - 25 * 60_000).toISOString(),
  },
  {
    id: consoleSeq++,
    workspaceId: null,
    connectionId: "c_staging",
    source: "user",
    sql: "select count(*) from payments",
    durationMs: 1290,
    rows: 1,
    error: null,
    at: new Date(now - 26 * 3_600_000).toISOString(),
  },
];

function log(entry: Omit<ConsoleEntry, "id" | "at">) {
  const e: ConsoleEntry = { ...entry, id: consoleSeq++, at: new Date().toISOString() };
  consoleEntries.push(e);
  if (consoleEntries.length > 2000) consoleEntries.splice(0, consoleEntries.length - 2000);
  mockEmitter.emit({ type: "console-appended", entry: e });
  return e;
}

function ws(id: WorkspaceId): MockWorkspace {
  const w = workspaces.get(id);
  if (!w) throw { code: "not-found", message: `Workspace ${id} is not open` };
  return w;
}

// ───────────────────────── query helpers ─────────────────────────

function compareCells(a: Cell, b: Cell, logical: LogicalType): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (logical === "int" || logical === "float" || logical === "decimal") {
    const na = typeof a === "number" ? a : parseFloat(String(a));
    const nb = typeof b === "number" ? b : parseFloat(String(b));
    return na - nb;
  }
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return String(a).localeCompare(String(b));
}

function likeToRegex(p: string) {
  return new RegExp("^" + p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".") + "$", "i");
}

function matchFilter(cell: Cell, f: Filter, logical: LogicalType): boolean {
  switch (f.op) {
    case "is-null":
      return cell == null;
    case "is-not-null":
      return cell != null;
  }
  if (cell == null) return false;
  const v = f.value ?? "";
  const cellStr = typeof cell === "object" ? JSON.stringify(cell) : String(cell);
  const cmp = () => compareCells(cell, logical === "bool" ? v === "true" : v, logical);
  switch (f.op) {
    case "eq":
      return cellStr === v || (logical !== "text" && cmp() === 0);
    case "neq":
      return !(cellStr === v || (logical !== "text" && cmp() === 0));
    case "lt":
      return cmp() < 0;
    case "lte":
      return cmp() <= 0;
    case "gt":
      return cmp() > 0;
    case "gte":
      return cmp() >= 0;
    case "like":
      return likeToRegex(v).test(cellStr);
    case "not-like":
      return !likeToRegex(v).test(cellStr);
    case "in":
      return v.split(",").map((s) => s.trim().replace(/^'(.*)'$/, "$1")).includes(cellStr);
  }
  return true;
}

function applyQuery(t: MockTable, filters: Filter[], sort: Sort[], limit: number | null, offset: number | null): Cell[][] {
  const cols = t.def.columns;
  const idx = (name: string) => cols.findIndex((c) => c.name === name);
  let rows = t.rows;
  for (const f of filters) {
    const i = idx(f.column);
    if (i < 0) throw { code: "invalid", message: `column "${f.column}" does not exist` };
    rows = rows.filter((r) => matchFilter(r[i], f, cols[i].logical));
  }
  if (sort.length) {
    const keys = sort.map((s) => ({ i: idx(s.column), dir: s.dir === "desc" ? -1 : 1, logical: cols[idx(s.column)]?.logical ?? "text" }));
    rows = [...rows].sort((a, b) => {
      for (const k of keys) {
        if (k.i < 0) continue;
        const c = compareCells(a[k.i], b[k.i], k.logical) * k.dir;
        if (c !== 0) return c;
      }
      return 0;
    });
  }
  if (offset) rows = rows.slice(offset);
  if (limit != null) rows = rows.slice(0, limit);
  return rows;
}

function openCursor(rows: Cell[][]): string {
  const id = `cur_${cursorSeq++}`;
  cursors.set(id, { rows });
  return id;
}

function lineCol(sql: string, index: number) {
  const before = sql.slice(0, index);
  const line = before.split("\n").length;
  const column = index - before.lastIndexOf("\n");
  return { line, column };
}

function splitStatements(sql: string): { text: string; start: number }[] {
  const out: { text: string; start: number }[] = [];
  let start = 0;
  let quote: string | null = null;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl < 0 ? sql.length : nl;
      continue;
    } else if (ch === ";") {
      out.push({ text: sql.slice(start, i), start });
      start = i + 1;
    }
    i++;
  }
  out.push({ text: sql.slice(start), start });
  return out.filter((s) => s.text.trim().length > 0);
}

function statementKind(text: string): QueryResult["kind"] {
  const w = text
    .trim()
    .replace(/^(--[^\n]*\n|\s)+/g, "")
    .split(/\s+/)[0]
    ?.toLowerCase();
  switch (w) {
    case "select":
    case "with":
    case "show":
    case "explain":
    case "values":
      return "select";
    case "insert":
      return "insert";
    case "update":
      return "update";
    case "delete":
      return "delete";
    case "create":
    case "alter":
    case "drop":
    case "truncate":
      return "ddl";
    default:
      return "other";
  }
}

function parseWhere(where: string, cols: ColDef[]): Filter[] {
  const filters: Filter[] = [];
  const re = /(\w+)\s*(=|!=|<>|>=|<=|>|<|ilike|like)\s*(?:'((?:[^']|'')*)'|(-?\d+(?:\.\d+)?)|(true|false|null))/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(where))) {
    const col = m[1];
    if (!cols.some((c) => c.name === col)) throw { message: `column "${col}" does not exist`, index: m.index };
    const opMap: Record<string, Filter["op"]> = { "=": "eq", "!=": "neq", "<>": "neq", ">=": "gte", "<=": "lte", ">": "gt", "<": "lt", like: "like", ilike: "like" };
    const value = m[3] != null ? m[3].replace(/''/g, "'") : m[4] != null ? m[4] : m[5].toLowerCase();
    filters.push({ column: col, op: opMap[m[2].toLowerCase()], value });
  }
  return filters;
}

function runStatement(w: MockWorkspace, sql: string, start: number, fullSql: string, limitArg: number | null | undefined): QueryResult {
  const t0 = performance.now();
  const kind = statementKind(sql);
  const base = { statement: sql.trim(), kind, columns: [] as ColumnDesc[], cursorId: null, rowCount: null, rowsAffected: null, truncated: false };
  const fail = (message: string, at: number | null, code: string | null, blocked = false): QueryResult => {
    const lc = at == null ? { line: null, column: null } : lineCol(fullSql, at);
    const error: QueryError = { message, line: lc.line, column: lc.column, code, blockedByPolicy: blocked };
    return { ...base, durationMs: Math.round(performance.now() - t0), error };
  };
  // The padlock and the policy, in the engine's order — one rule, one place.
  const refused = refusal(w, kind, kind !== "other", kind === "update" || kind === "delete" ? /\bwhere\b/i.test(sql) : null);
  if (refused) return fail(refused, null, "policy", true);
  if (kind === "update" || kind === "delete" || kind === "ddl" || kind === "insert") {
    return { ...base, rowsAffected: 1 + Math.floor(Math.random() * 20), durationMs: 5 + Math.floor(Math.random() * 30), error: null };
  }
  if (kind === "other") {
    return fail(`syntax error at or near "${sql.trim().split(/\s+/)[0] ?? ""}"`, start + (sql.length - sql.trimStart().length), "42601");
  }
  const tables = tablesFor(w.info.connectionId, w.info.database);
  const fromMatch = /\bfrom\s+("?[\w]+"?(?:\."?[\w]+"?)?)/i.exec(sql);
  let rows: Cell[][];
  let columns: ColumnDesc[];
  if (!fromMatch) {
    const selMatch = /select\s+(.*)$/is.exec(sql.trim());
    const expr = (selMatch?.[1] ?? "1").trim();
    const num = /^-?\d+(\.\d+)?$/.test(expr);
    columns = [{ name: num ? "?column?" : expr.toLowerCase().replace(/\(.*$/, ""), dataType: num ? "integer" : "text", logical: num ? "int" : "text", wire: num ? "number" : "string", nullable: true }];
    rows = [[num ? Number(expr) : /^now\(\)/i.test(expr) ? new Date().toISOString() : /^version\(\)/i.test(expr) ? w.info.serverVersion : expr.replace(/^'(.*)'$/, "$1")]];
  } else {
    const raw = fromMatch[1].replace(/"/g, "");
    const [a, b] = raw.split(".");
    const ref: TableRef = b ? { schema: a, name: b } : { schema: null, name: a };
    const t = resolveTable(tables, ref);
    if (!t || t.def.kind === "function" || t.def.kind === "sequence") {
      return fail(`relation "${raw}" does not exist`, start + fromMatch.index + fromMatch[0].length - fromMatch[1].length, "42P01");
    }
    let filters: Filter[] = [];
    const whereMatch = /\bwhere\s+(.*?)(\border\s+by\b|\blimit\b|$)/is.exec(sql);
    if (whereMatch) {
      try {
        filters = parseWhere(whereMatch[1], t.def.columns);
      } catch (e) {
        const err = e as { message: string; index: number };
        return fail(err.message, start + whereMatch.index + whereMatch[0].indexOf(whereMatch[1]) + err.index, "42703");
      }
    }
    const sort: Sort[] = [];
    const orderMatch = /\border\s+by\s+(\w+)(\s+(asc|desc))?/i.exec(sql);
    if (orderMatch) sort.push({ column: orderMatch[1], dir: (orderMatch[3]?.toLowerCase() as Sort["dir"]) ?? "asc" });
    const limitMatch = /\blimit\s+(\d+)/i.exec(sql);
    const sqlLimit = limitMatch ? Number(limitMatch[1]) : null;
    const selMatch = /select\s+(.*?)\s+from\b/is.exec(sql);
    const sel = (selMatch?.[1] ?? "*").trim();
    const all = applyQuery(t, filters, sort, null, null);
    const tref: TableRef = { schema: t.def.schema, name: t.def.name };
    if (/^count\(\*\)$/i.test(sel)) {
      columns = [{ name: "count", dataType: "bigint", logical: "int", wire: "string", nullable: false }];
      rows = [[String(all.length)]];
    } else if (sel === "*") {
      columns = t.def.columns.map((c) => colDesc(c, tref));
      rows = all;
    } else {
      const names = sel.split(",").map((s) => s.trim().replace(/\s+as\s+\w+$/i, "").replace(/"/g, ""));
      const idxs = names.map((n) => t.def.columns.findIndex((c) => c.name === n));
      const bad = idxs.indexOf(-1);
      if (bad >= 0) {
        const at = start + (selMatch ? selMatch.index + selMatch[0].indexOf(names[bad]) : 0);
        return fail(`column "${names[bad]}" does not exist`, at, "42703");
      }
      columns = idxs.map((i) => colDesc(t.def.columns[i], tref));
      rows = all.map((r) => idxs.map((i) => r[i]));
    }
    if (sqlLimit != null) rows = rows.slice(0, sqlLimit);
  }
  let truncated = false;
  if (limitArg != null && rows.length > limitArg) {
    rows = rows.slice(0, limitArg);
    truncated = true;
  }
  const cursorId = openCursor(rows);
  return { ...base, columns, cursorId, rowCount: rows.length, truncated, durationMs: Math.round(performance.now() - t0) + 4 + Math.floor(Math.random() * 60), error: null };
}

// ───────────────────────── saved queries ─────────────────────────

let savedQueries: SavedQuery[] = lsGet<SavedQuery[]>("plinth:mock:saved", [
  { id: "sq_1", connectionId: "c_prod", name: "orders by day", folder: "Reports", sql: "select date_trunc('day', created_at) as day, count(*) as orders, sum(amount) as revenue\nfrom orders\ngroup by 1\norder by 1 desc;", updatedAt: new Date(now - 3 * 86_400_000).toISOString() },
  { id: "sq_2", connectionId: "c_prod", name: "unpaid > 1k", folder: "Reports", sql: "select * from orders where status = 'pending' and amount > 1000 order by amount desc;", updatedAt: new Date(now - 86_400_000).toISOString() },
  { id: "sq_3", connectionId: null, name: "server version", folder: null, sql: "select version();", updatedAt: new Date(now - 10 * 86_400_000).toISOString() },
]);
const persistSaved = () => lsSet("plinth:mock:saved", savedQueries);

// ───────────────────────── DDL ─────────────────────────

function ddlFor(t: MockTable): string {
  const d = t.def;
  if (d.kind === "view") {
    return `CREATE OR REPLACE VIEW ${d.schema}.${d.name} AS\nSELECT date_trunc('day', captured_at)::date AS day,\n       count(*)            AS payouts,\n       sum(amount)         AS total\nFROM   public.payments\nWHERE  captured\nGROUP  BY 1;`;
  }
  const lines = d.columns.map((c) => `    ${c.name.padEnd(12)} ${c.dataType}${c.nullable ? "" : " NOT NULL"}${c.default ? ` DEFAULT ${c.default}` : ""}`);
  const pk = d.columns.filter((c) => c.pk).map((c) => c.name);
  if (pk.length) lines.push(`    PRIMARY KEY (${pk.join(", ")})`);
  for (const fk of d.foreignKeys ?? []) lines.push(`    CONSTRAINT ${fk.name} FOREIGN KEY (${fk.columns.join(", ")}) REFERENCES ${fk.refTable.schema}.${fk.refTable.name} (${fk.refColumns.join(", ")})`);
  const idx = (d.indexes ?? []).filter((i) => !i.primary).map((i) => `CREATE ${i.unique ? "UNIQUE " : ""}INDEX ${i.name} ON ${d.schema}.${d.name} (${i.columns.join(", ")});`);
  return `CREATE TABLE ${d.schema}.${d.name} (\n${lines.join(",\n")}\n);${idx.length ? "\n\n" + idx.join("\n") : ""}`;
}

// ───────────────────────── the command table ─────────────────────────

/**
 * A real `EXPLAIN (ANALYZE, FORMAT JSON, BUFFERS)` captured from Postgres —
 * a join whose sort spilled to disk — so the plan view can be exercised in
 * browser mode against something the parser will actually meet.
 */
const EXPLAIN_FIXTURE = "[{\"Plan\":{\"Node Type\":\"Limit\",\"Startup Cost\":227.41,\"Total Cost\":227.46,\"Plan Rows\":20,\"Actual Total Time\":10.292,\"Actual Rows\":20,\"Actual Loops\":1,\"Shared Hit Blocks\":41,\"Temp Read Blocks\":9,\"Temp Written Blocks\":10,\"Plans\":[{\"Node Type\":\"Sort\",\"Startup Cost\":227.41,\"Total Cost\":228.66,\"Plan Rows\":500,\"Actual Total Time\":10.288,\"Actual Rows\":20,\"Actual Loops\":1,\"Sort Key\":[\"(sum(o.total)) DESC\"],\"Sort Method\":\"top-N heapsort\",\"Sort Space Used\":27,\"Sort Space Type\":\"Memory\",\"Shared Hit Blocks\":41,\"Temp Read Blocks\":9,\"Temp Written Blocks\":10,\"Plans\":[{\"Node Type\":\"Aggregate\",\"Startup Cost\":192.85,\"Total Cost\":214.1,\"Plan Rows\":500,\"Actual Total Time\":10.148,\"Actual Rows\":375,\"Actual Loops\":1,\"Group Key\":[\"c.name\"],\"Shared Hit Blocks\":38,\"Temp Read Blocks\":9,\"Temp Written Blocks\":10,\"Plans\":[{\"Node Type\":\"Sort\",\"Startup Cost\":192.85,\"Total Cost\":196.6,\"Plan Rows\":1500,\"Actual Total Time\":9.57,\"Actual Rows\":1500,\"Actual Loops\":1,\"Sort Key\":[\"c.name\"],\"Sort Method\":\"external merge\",\"Sort Space Used\":72,\"Sort Space Type\":\"Disk\",\"Shared Hit Blocks\":38,\"Temp Read Blocks\":9,\"Temp Written Blocks\":10,\"Plans\":[{\"Node Type\":\"Hash Join\",\"Startup Cost\":17.25,\"Total Cost\":75.22,\"Plan Rows\":1500,\"Actual Total Time\":0.865,\"Actual Rows\":1500,\"Actual Loops\":1,\"Hash Cond\":\"(o.customer_id = c.id)\",\"Shared Hit Blocks\":35,\"Temp Read Blocks\":0,\"Temp Written Blocks\":0,\"Plans\":[{\"Node Type\":\"Seq Scan\",\"Relation Name\":\"orders\",\"Alias\":\"o\",\"Startup Cost\":0.0,\"Total Cost\":54.0,\"Plan Rows\":1500,\"Actual Total Time\":0.438,\"Actual Rows\":1500,\"Actual Loops\":1,\"Filter\":\"(status <> 'refunded'::text)\",\"Rows Removed by Filter\":500,\"Shared Hit Blocks\":29,\"Temp Read Blocks\":0,\"Temp Written Blocks\":0},{\"Node Type\":\"Hash\",\"Startup Cost\":11.0,\"Total Cost\":11.0,\"Plan Rows\":500,\"Actual Total Time\":0.093,\"Actual Rows\":500,\"Actual Loops\":1,\"Hash Batches\":1,\"Shared Hit Blocks\":6,\"Temp Read Blocks\":0,\"Temp Written Blocks\":0,\"Plans\":[{\"Node Type\":\"Seq Scan\",\"Relation Name\":\"customers\",\"Alias\":\"c\",\"Startup Cost\":0.0,\"Total Cost\":11.0,\"Plan Rows\":500,\"Actual Total Time\":0.049,\"Actual Rows\":500,\"Actual Loops\":1,\"Shared Hit Blocks\":6,\"Temp Read Blocks\":0,\"Temp Written Blocks\":0}]}]}]}]}]}]},\"Planning Time\":0.918,\"Execution Time\":10.698}]";

// The context the AI pane last sent, for `window.plinthMock.lastContext()`.
let lastAskContext = "";

// Mutable bits the AI-setup mocks pretend to change.
let mockOllamaModels: string[] = ["llama3.2:3b"];
let mockPull: AiStatus["pulling"] = null;
const mockMcpRegistered = new Set<string>(["claude-code"]);


/**
 * The same refusals `crates/core/src/policy.rs` makes, in the same order:
 * the padlock first, then the connection's policy. Kept in step by hand —
 * a mock that is more permissive than the engine teaches the UI bad habits.
 */
function refusal(w: MockWorkspace, kind: StatementKind, parsed: boolean, hasWhere: boolean | null): string | null {
  const write = kind !== "select";
  // The connection's policy first, then the padlock — so the message names
  // the constraint that actually binds.
  if (w.info.policy === "read-only" && (write || !parsed)) {
    return `Blocked by read-only policy: ${kind.toUpperCase()} is not allowed on this connection.`;
  }
  if (w.info.policy === "read-write") {
    if (kind === "ddl") return "Blocked by read-write policy: DDL is not allowed on this connection. Switch the connection to the full policy to run DDL.";
    if ((kind === "update" || kind === "delete") && hasWhere === false) return `Blocked by read-write policy: ${kind.toUpperCase()} requires a WHERE clause under read-write policy.`;
  }
  if (w.safeMode) {
    if (!parsed) return "Blocked by safe mode: this statement could not be parsed, so it cannot be verified as read-only. Unlock safe mode in the toolbar to run it.";
    if (write) return `Blocked by safe mode: this ${kind.toUpperCase()} is not allowed while the padlock is on. Unlock it in the toolbar to run this.`;
  }
  return null;
}

export const mock: Commands = {
  async connections_list() {
    await latency();
    return connections.map((c) => ({ ...c }));
  },

  async connections_save({ profile }) {
    await latency();
    const p: ConnectionProfile = { ...profile, id: profile.id || `c_${Math.random().toString(36).slice(2, 8)}` };
    const i = connections.findIndex((c) => c.id === p.id);
    if (i >= 0) connections[i] = p;
    else connections.push(p);
    persistConnections();
    return { ...p };
  },

  async connections_delete({ id }) {
    await latency();
    connections = connections.filter((c) => c.id !== id);
    persistConnections();
  },

  async connection_test({ profile }) {
    const stages: TestReport["stages"] = [];
    const bad = (profile.host ?? "").includes("bad") || (profile.filePath ?? "").includes("missing");
    const stageNames = profile.driver === "sqlite" ? ["file", "open", "pragma"] : ["tcp", profile.ssl === "disable" ? null : "tls", "auth", "ping"].filter(Boolean) as string[];
    for (const name of stageNames) {
      await delay(80 + Math.random() * 200);
      const fails = bad && (name === "tcp" || name === "file");
      stages.push({ name, ok: !fails, durationMs: Math.round(10 + Math.random() * 70), error: fails ? (profile.driver === "sqlite" ? "No such file" : "Connection refused (ECONNREFUSED)") : null });
      if (fails) break;
    }
    const ok = stages.every((s) => s.ok);
    return { ok, stages, serverVersion: ok ? (profile.driver === "sqlite" ? "SQLite 3.46.0" : profile.driver === "mysql" ? "MySQL 8.0.36" : "PostgreSQL 16.3") : null };
  },

  async workspace_open({ connectionId, database }) {
    await latency();
    const c = connections.find((x) => x.id === connectionId);
    if (!c) throw { code: "not-found", message: `Connection ${connectionId} not found` };
    const dbs = databasesFor(c);
    const db = database ?? c.database ?? dbs[0];
    if (!dbs.includes(db)) throw { code: "driver", message: `database "${db}" does not exist` };
    const id = `ws_${wsSeq++}`;
    const info: WorkspaceInfo = {
      id,
      connectionId,
      connectionName: c.name,
      driver: c.driver,
      environment: c.environment,
      policy: c.policy,
      database: db,
      databases: dbs,
      serverVersion: c.driver === "sqlite" ? "SQLite 3.46.0" : "PostgreSQL 16.3",
      tls: c.ssl !== "disable" && c.driver !== "sqlite",
    };
    // Same default as the engine: on where a mistake would be expensive.
    workspaces.set(id, { info, safeMode: c.policy === "read-only" || c.environment === "production" });
    c.lastUsedAt = new Date().toISOString();
    persistConnections();
    mockEmitter.emit({ type: "connection-state", workspaceId: id, state: "connecting", detail: c.driver === "sqlite" ? "Opening file…" : "Connecting through SSM…" });
    setTimeout(() => mockEmitter.emit({ type: "connection-state", workspaceId: id, state: "up", detail: null }), 300);
    return { ...info, databases: [...dbs] };
  },

  async workspace_close({ workspaceId }) {
    await latency();
    workspaces.delete(workspaceId);
  },

  async workspace_list() {
    await latency();
    return Array.from(workspaces.values()).map((w) => ({ ...w.info }));
  },

  async schema_index({ workspaceId }) {
    const w = ws(workspaceId);
    await delay(120 + Math.random() * 150);
    const tables = tablesFor(w.info.connectionId, w.info.database);
    const schemas = new Map<string, SchemaIndex["schemas"][number]>();
    const columns: SchemaIndex["columns"] = [];
    for (const [, t] of tables) {
      let s = schemas.get(t.def.schema);
      if (!s) schemas.set(t.def.schema, (s = { name: t.def.schema, isSystem: false, objects: [] }));
      s.objects.push({ schema: t.def.schema, name: t.def.name, kind: t.def.kind, rowEstimate: t.def.rowEstimate });
      for (const c of t.def.columns) columns.push({ schema: t.def.schema, table: t.def.name, column: c.name });
    }
    if (w.info.driver === "postgres") {
      schemas.set("pg_catalog", { name: "pg_catalog", isSystem: true, objects: [{ schema: "pg_catalog", name: "pg_class", kind: "table", rowEstimate: 412 }, { schema: "pg_catalog", name: "pg_stat_activity", kind: "view", rowEstimate: null }] });
    }
    log({ workspaceId, connectionId: w.info.connectionId, source: "app", sql: "SELECT n.nspname, c.relname, c.relkind, c.reltuples FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace", durationMs: 12, rows: columns.length, error: null });
    return { schemas: Array.from(schemas.values()), columns, generatedAt: new Date().toISOString() };
  },

  async schema_graph({ workspaceId }): Promise<SchemaGraph> {
    const w = ws(workspaceId);
    await delay(80);
    const tables = tablesFor(w.info.connectionId, w.info.database);
    const nodes: SchemaGraph["nodes"] = [];
    const edges: SchemaGraph["edges"] = [];
    for (const [, t] of tables) {
      // Same filter as `graph::build`: relations only, never sequences or functions.
      if (t.def.kind !== "table" && t.def.kind !== "view" && t.def.kind !== "materialized-view") continue;
      nodes.push({
        table: { schema: t.def.schema, name: t.def.name },
        kind: t.def.kind,
        columns: t.def.columns.map((c) => c.name),
        rowEstimate: t.def.rowEstimate ?? null,
      });
      for (const fk of t.def.foreignKeys ?? []) {
        edges.push({
          from: { schema: t.def.schema, name: t.def.name },
          fromColumns: fk.columns,
          to: fk.refTable,
          toColumns: fk.refColumns,
          name: fk.name,
          inferred: false,
        });
      }
    }
    // Same conservative rule as the engine, so the mock exercises both paths.
    const byName = new Map(nodes.map((n) => [n.table.name.toLowerCase(), n]));
    for (const n of nodes) {
      for (const c of n.columns) {
        const base = c.toLowerCase().endsWith("_id") ? c.toLowerCase().slice(0, -3) : null;
        if (!base) continue;
        const target = byName.get(base) ?? byName.get(`${base}s`) ?? byName.get(`${base}es`);
        if (!target || target.table.name === n.table.name) continue;
        const key = target.columns.find((x) => x.toLowerCase() === "id");
        if (!key) continue;
        if (edges.some((e) => e.from.name === n.table.name && e.fromColumns[0]?.toLowerCase() === c.toLowerCase())) continue;
        edges.push({ from: n.table, fromColumns: [c], to: target.table, toColumns: [key], name: null, inferred: true });
      }
    }
    return { nodes, edges, generatedAt: new Date().toISOString() };
  },

  /** Diffs the two mock databases by comparing their table definitions,
   *  so the view can be exercised without two live servers. */
  async schema_diff({ leftWorkspaceId, rightWorkspaceId }): Promise<SchemaDiff> {
    const l = ws(leftWorkspaceId);
    const r = ws(rightWorkspaceId);
    await delay(200);
    const lefts = tablesFor(l.info.connectionId, l.info.database);
    const rights = tablesFor(r.info.connectionId, r.info.database);
    const names = [...new Set([...lefts.keys(), ...rights.keys()])].sort();
    const summary = { tablesAdded: 0, tablesRemoved: 0, tablesChanged: 0, columnsAdded: 0, columnsRemoved: 0, columnsChanged: 0 };

    const tables: SchemaDiff["tables"] = names.map((name) => {
      const lt = lefts.get(name);
      const rt = rights.get(name);
      const table = { schema: (lt ?? rt)!.def.schema, name: (lt ?? rt)!.def.name };
      const kind = (lt ?? rt)!.def.kind;
      if (lt && !rt) {
        summary.tablesAdded++;
        summary.columnsAdded += lt.def.columns.length;
        return { table, kind, status: "added" as const, primaryKeyChanged: false, indexes: [],
          columns: lt.def.columns.map((c) => ({ name: c.name, status: "added" as const, left: { name: c.name, dataType: c.dataType, nullable: c.nullable, default: c.default ?? null, ordinal: 0 }, right: null, changes: [] })) };
      }
      if (!lt && rt) {
        summary.tablesRemoved++;
        summary.columnsRemoved += rt.def.columns.length;
        return { table, kind, status: "removed" as const, primaryKeyChanged: false, indexes: [],
          columns: rt.def.columns.map((c) => ({ name: c.name, status: "removed" as const, left: null, right: { name: c.name, dataType: c.dataType, nullable: c.nullable, default: c.default ?? null, ordinal: 0 }, changes: [] })) };
      }
      const lc = new Map(lt!.def.columns.map((c) => [c.name, c]));
      const rc = new Map(rt!.def.columns.map((c) => [c.name, c]));
      const cols = [...new Set([...lc.keys(), ...rc.keys()])].sort().map((cn) => {
        const a = lc.get(cn);
        const b = rc.get(cn);
        const snap = (c?: typeof a) => (c ? { name: c.name, dataType: c.dataType, nullable: c.nullable, default: c.default ?? null, ordinal: 0 } : null);
        if (a && !b) { summary.columnsAdded++; return { name: cn, status: "added" as const, left: snap(a), right: null, changes: [] }; }
        if (!a && b) { summary.columnsRemoved++; return { name: cn, status: "removed" as const, left: null, right: snap(b), changes: [] }; }
        const changes = [
          a!.dataType !== b!.dataType ? "type" : null,
          a!.nullable !== b!.nullable ? "nullability" : null,
        ].filter(Boolean) as string[];
        if (changes.length) summary.columnsChanged++;
        return { name: cn, status: (changes.length ? "changed" : "same") as "changed" | "same", left: snap(a), right: snap(b), changes };
      });
      const changed = cols.some((c) => c.status !== "same");
      if (changed) summary.tablesChanged++;
      return { table, kind, status: (changed ? "changed" : "same") as "changed" | "same", columns: cols, indexes: [], primaryKeyChanged: false };
    });

    return { tables, leftLabel: `${l.info.connectionName} · ${l.info.database}`, rightLabel: `${r.info.connectionName} · ${r.info.database}`, summary };
  },

  async migration_sql({ diff }): Promise<string> {
    await latency();
    const lines = [
      `-- Migration: make ${diff.rightLabel} match ${diff.leftLabel}.`,
      "-- Generated by Plinth. Destructive statements are commented out on purpose —",
      "-- read them, then un-comment the ones you mean.",
      "",
      "BEGIN;",
      "",
    ];
    for (const t of diff.tables) {
      const name = `${t.table.schema ? `"${t.table.schema}".` : ""}"${t.table.name}"`;
      if (t.status === "same") continue;
      if (t.kind !== "table") { lines.push(`-- ${name} is a ${t.kind}; recreate it from its definition.`); continue; }
      if (t.status === "added") { lines.push(`CREATE TABLE IF NOT EXISTS ${name} (\n${t.columns.map((c) => `  "${c.name}" ${c.left?.dataType}${c.left?.nullable ? "" : " NOT NULL"}`).join(",\n")}\n);`); continue; }
      if (t.status === "removed") { lines.push(`-- ${name} exists only in ${diff.rightLabel}:`, `-- DROP TABLE ${name};`); continue; }
      for (const c of t.columns) {
        if (c.status === "added") lines.push(`ALTER TABLE ${name} ADD COLUMN IF NOT EXISTS "${c.name}" ${c.left?.dataType};`);
        if (c.status === "removed") lines.push(`-- ALTER TABLE ${name} DROP COLUMN "${c.name}";`);
        if (c.status === "changed" && c.changes.includes("type")) lines.push(`ALTER TABLE ${name} ALTER COLUMN "${c.name}" TYPE ${c.left?.dataType};`);
      }
    }
    lines.push("", "COMMIT;");
    return lines.join("\n");
  },

  async table_describe({ workspaceId, table }) {
    const w = ws(workspaceId);
    await latency();
    const t = resolveTable(tablesFor(w.info.connectionId, w.info.database), table);
    if (!t) throw { code: "not-found", message: `relation "${table.schema ? table.schema + "." : ""}${table.name}" does not exist` };
    log({ workspaceId, connectionId: w.info.connectionId, source: "app", sql: `SELECT * FROM information_schema.columns WHERE table_schema = '${t.def.schema}' AND table_name = '${t.def.name}'`, durationMs: 4, rows: t.def.columns.length, error: null });
    const columns: ColumnInfo[] = t.def.columns.map((c, i) => ({ name: c.name, dataType: c.dataType, logical: c.logical, nullable: c.nullable, default: c.default ?? null, isPrimaryKey: !!c.pk, ordinal: i + 1 }));
    const schema: TableSchema = {
      table: { schema: t.def.schema, name: t.def.name },
      kind: t.def.kind,
      columns,
      primaryKey: t.def.columns.filter((c) => c.pk).map((c) => c.name),
      foreignKeys: t.def.foreignKeys ?? [],
      indexes: t.def.indexes ?? [],
      ddl: ddlFor(t),
      rowEstimate: t.def.rowEstimate,
    };
    return schema;
  },

  async table_open({ workspaceId, table, query }) {
    const w = ws(workspaceId);
    await latency();
    const t0 = performance.now();
    const t = resolveTable(tablesFor(w.info.connectionId, w.info.database), table);
    const sqlText = `SELECT * FROM ${table.schema ? `${table.schema}.` : ""}${table.name}${query.filters.length ? " WHERE " + query.filters.map((f) => `${f.column} ${f.op} ${f.value == null ? "" : `'${f.value}'`}`.trim()).join(" AND ") : ""}${query.sort.length ? " ORDER BY " + query.sort.map((s) => `${s.column} ${s.dir.toUpperCase()}`).join(", ") : ""}${query.limit != null ? ` LIMIT ${query.limit}` : ""}`;
    if (!t) {
      log({ workspaceId, connectionId: w.info.connectionId, source: "app", sql: sqlText, durationMs: 2, rows: null, error: "relation does not exist" });
      throw { code: "not-found", message: `relation "${table.name}" does not exist` };
    }
    let rows: Cell[][];
    try {
      rows = applyQuery(t, query.filters, query.sort, query.limit, query.offset);
    } catch (e) {
      const msg = (e as { message: string }).message;
      log({ workspaceId, connectionId: w.info.connectionId, source: "app", sql: sqlText, durationMs: 2, rows: null, error: msg });
      return { statement: sqlText, kind: "select", columns: [], cursorId: null, rowCount: null, rowsAffected: null, truncated: false, durationMs: 2, error: { message: msg, line: null, column: null, code: "42703", blockedByPolicy: false } };
    }
    const durationMs = Math.round(performance.now() - t0) + 8 + Math.floor(Math.random() * 40);
    log({ workspaceId, connectionId: w.info.connectionId, source: "app", sql: sqlText, durationMs, rows: rows.length, error: null });
    const tref: TableRef = { schema: t.def.schema, name: t.def.name };
    return {
      statement: sqlText,
      kind: "select",
      columns: t.def.columns.map((c) => colDesc(c, tref)),
      cursorId: openCursor(rows),
      rowCount: rows.length,
      rowsAffected: null,
      truncated: query.limit != null && rows.length >= query.limit,
      durationMs,
      error: null,
    };
  },

  async table_count({ workspaceId, table, exact }) {
    const w = ws(workspaceId);
    await delay(exact ? 600 + Math.random() * 900 : 40);
    const t = resolveTable(tablesFor(w.info.connectionId, w.info.database), table);
    if (!t) throw { code: "not-found", message: "relation does not exist" };
    log({ workspaceId, connectionId: w.info.connectionId, source: "app", sql: exact ? `SELECT count(*) FROM ${t.def.schema}.${t.def.name}` : `SELECT reltuples::bigint FROM pg_class WHERE oid = '${t.def.schema}.${t.def.name}'::regclass`, durationMs: exact ? 812 : 3, rows: 1, error: null });
    return exact ? t.rows.length : (t.def.rowEstimate ?? t.rows.length);
  },

  async query_run({ workspaceId, sql, limit, source }) {
    const w = ws(workspaceId);
    await latency();
    // EXPLAIN comes back as one JSON cell, exactly as Postgres returns it.
    // The fixture is a real plan captured from a live server, spilling sort
    // and all, so the plan view can be exercised in the browser.
    if (/^\s*explain/i.test(sql)) {
      const plan = EXPLAIN_FIXTURE;
      const cursorId = `cur_${Math.random().toString(36).slice(2)}`;
      cursors.set(cursorId, { rows: [[plan]] });
      log({ workspaceId, connectionId: w.info.connectionId, source: source ?? "user", sql, durationMs: 3, rows: 1, error: null });
      return [{
        statement: sql,
        kind: "select",
        columns: [{ name: "QUERY PLAN", dataType: "json", logical: "json", wire: "json", nullable: true }],
        cursorId,
        rowCount: 1,
        rowsAffected: null,
        truncated: false,
        durationMs: 3,
        error: null,
      }];
    }
    const parts = splitStatements(sql);
    const results: QueryResult[] = [];
    for (const p of parts) {
      const r = runStatement(w, p.text, p.start, sql, limit);
      log({ workspaceId, connectionId: w.info.connectionId, source: source ?? "user", sql: r.statement, durationMs: r.durationMs, rows: r.rowCount ?? r.rowsAffected, error: r.error?.message ?? null });
      results.push(r);
      if (r.error) break;
    }
    return results;
  },

  /// Mirrors the engine's classifier closely enough to exercise the UI paths.
  /** The shell owns windows; in the browser `lib/windows.ts` uses window.open
   *  directly, so these exist only to keep the contract total. */
  async window_open() {
    return "browser";
  },
  async window_focus() {
    return false;
  },
  async window_list() {
    return ["main"];
  },

  async workspace_set_safe_mode({ workspaceId, on }) {
    ws(workspaceId).safeMode = on;
  },

  /** Mirrors the engine: read-only is never elevated, safe mode still wins,
   *  and the policy goes back where it was. */
  async query_run_elevated({ workspaceId, sql, limit }) {
    const w = ws(workspaceId);
    if (w.info.policy === "read-only") throw new Error("This connection is read-only. Change its policy in the connection settings to write to it.");
    if (w.safeMode) throw new Error("Safe mode is on. Unlock the padlock first — it is a separate decision from the connection's policy.");
    const saved = w.info.policy;
    w.info = { ...w.info, policy: "full" };
    try {
      return await mock.query_run({ workspaceId, sql, limit, source: "user" });
    } finally {
      w.info = { ...w.info, policy: saved };
    }
  },

  async explain_hypothetical() {
    // The mock has no planner to ask, so it answers the way a server without
    // hypopg does: it cannot be measured.
    throw new Error("The hypopg extension is not installed on this database, so an index cannot be tested without building it.");
  },

  async sql_check({ workspaceId, sql }): Promise<SqlCheck> {
    await latency();
    const w = ws(workspaceId);
    const parts = sql
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    const statements = parts.map((s) => {
      const kw = s.split(/\s+/)[0]?.toLowerCase() ?? "";
      const kind: StatementKind =
        kw === "select" || kw === "with" || kw === "explain"
          ? "select"
          : kw === "insert"
            ? "insert"
            : kw === "update"
              ? "update"
              : kw === "delete"
                ? "delete"
                : ["create", "alter", "drop", "truncate", "grant", "revoke"].includes(kw)
                  ? "ddl"
                  : "other";
      const parsed = kind !== "other";
      const hasWhere = kind === "update" || kind === "delete" ? /\bwhere\b/i.test(s) : null;
      const blockedReason = refusal(w, kind, parsed, hasWhere);
      return { sql: s, kind, parsed, hasWhere, isExplain: kw === "explain", allowed: !blockedReason, blockedReason };
    });
    return {
      statements,
      readOnly: statements.length > 0 && statements.every((s) => s.parsed && s.kind === "select"),
      allowed: statements.every((s) => s.allowed),
      policy: w.info.policy,
    };
  },

  async query_cancel({ workspaceId }) {
    const w = ws(workspaceId);
    await delay(20);
    log({ workspaceId, connectionId: w.info.connectionId, source: "app", sql: "SELECT pg_cancel_backend(pid)", durationMs: 2, rows: 1, error: null });
  },

  async cursor_fetch({ cursorId, offset, len }) {
    await delay(20 + Math.random() * 60);
    const c = cursors.get(cursorId);
    if (!c) throw { code: "not-found", message: `Cursor ${cursorId} is closed` };
    const rows = c.rows.slice(offset, offset + len);
    const win: RowWindow = { cursorId, offset, rows, buffered: c.rows.length, truncated: false, exhausted: offset + rows.length >= c.rows.length };
    return win;
  },

  async cursor_close({ cursorId }) {
    cursors.delete(cursorId);
  },

  async changes_preview({ workspaceId, changes }) {
    ws(workspaceId);
    await latency();
    return { statements: statementsFor(changes), affectedEstimate: changes.updates.length + changes.inserts.length + changes.deletes.length };
  },

  async changes_apply({ workspaceId, changes }) {
    const w = ws(workspaceId);
    await delay(80 + Math.random() * 200);
    if (w.info.policy === "read-only") {
      throw { code: "policy", message: `Blocked by policy: ${w.info.connectionName} is read-only`, detail: "Change the policy in the connection settings to allow writes." };
    }
    const statements = statementsFor(changes);
    const tables = tablesFor(w.info.connectionId, w.info.database);
    const t = changes.table ? resolveTable(tables, changes.table) : null;
    let rowsAffected = 0;
    if (t) {
      const cols = t.def.columns;
      const pkIdx = cols.filter((c) => c.pk).map((c) => cols.indexOf(c));
      const findRow = (pk: Record<string, Cell>) => t.rows.findIndex((r) => pkIdx.every((i) => String(r[i]) === String(pk[cols[i].name])));
      for (const u of changes.updates) {
        const ri = findRow(u.pk);
        const ci = cols.findIndex((c) => c.name === u.column);
        if (ri >= 0 && ci >= 0) {
          t.rows[ri] = [...t.rows[ri]];
          t.rows[ri][ci] = u.value;
          rowsAffected++;
        }
      }
      for (const d of changes.deletes) {
        const ri = findRow(d.pk);
        if (ri >= 0) {
          t.rows.splice(ri, 1);
          rowsAffected++;
        }
      }
      for (const ins of changes.inserts) {
        const row = cols.map((c) => (c.name in ins.values ? ins.values[c.name] : c.pk ? (c.wire === "string" ? String(t.rows.length + 1) : t.rows.length + 1) : c.default ? defaultValue(c) : null));
        t.rows.unshift(row);
        rowsAffected++;
      }
    }
    const durationMs = 6 + Math.floor(Math.random() * 40);
    for (const s of statements) log({ workspaceId, connectionId: w.info.connectionId, source: "user", sql: s, durationMs: Math.max(1, Math.round(durationMs / statements.length)), rows: 1, error: null });
    const out: ChangeOutcome = { statements, rowsAffected, durationMs };
    return out;
  },

  async console_list({ workspaceId, limit }) {
    await delay(10);
    const list = workspaceId ? consoleEntries.filter((e) => e.workspaceId === workspaceId) : consoleEntries;
    return list.slice(-limit).map((e) => ({ ...e }));
  },

  async history_list({ connectionId, limit }) {
    await delay(10);
    return consoleEntries
      .filter((e) => e.connectionId === connectionId && e.source === "user")
      .slice(-limit)
      .reverse()
      .map((e) => ({ ...e }));
  },

  async saved_list({ connectionId } = {}) {
    await delay(10);
    return savedQueries.filter((q) => !connectionId || q.connectionId == null || q.connectionId === connectionId).map((q) => ({ ...q }));
  },

  async saved_save({ query }) {
    await latency();
    const q: SavedQuery = { ...query, id: query.id || `sq_${Math.random().toString(36).slice(2, 8)}`, updatedAt: new Date().toISOString() };
    const i = savedQueries.findIndex((x) => x.id === q.id);
    if (i >= 0) savedQueries[i] = q;
    else savedQueries.push(q);
    persistSaved();
    return { ...q };
  },

  async saved_delete({ id }) {
    await latency();
    savedQueries = savedQueries.filter((q) => q.id !== id);
    persistSaved();
  },

  async state_get({ key }) {
    return lsGet<JsonValue>(`plinth:state:${key}`, null);
  },

  async state_set({ key, value }) {
    lsSet(`plinth:state:${key}`, value);
  },

  async sqlite_pick_file() {
    await delay(300);
    return "/Users/me/Data/analytics.db";
  },

  // ── ai setup ──
  // A believable 24 GB Apple Silicon laptop with Ollama up and one model pulled.

  async ai_probe() {
    await latency();
    const installed = mockOllamaModels.map((name) => ({ name, sizeGb: 2.0, parameterSize: "3.2B", quantization: "Q4_K_M" }));
    const usableModelGb = 18;
    const catalogue: [string, string, number, number, number, string][] = [
      ["llama3.3:70b", "Llama 3.3 70B", 70, 43, 50, "Only on a 64 GB+ machine"],
      ["qwen2.5-coder:32b", "Qwen2.5 Coder 32B", 32, 20, 26, "Strongest SQL that runs locally"],
      ["qwen2.5-coder:14b", "Qwen2.5 Coder 14B", 14, 9, 13, "Strong SQL, comfortable on 24 GB"],
      ["llama3.1:8b", "Llama 3.1 8B", 8, 4.9, 9, "General purpose"],
      ["qwen2.5-coder:7b", "Qwen2.5 Coder 7B", 7, 4.7, 8, "Best small SQL writer"],
      ["llama3.2:3b", "Llama 3.2 3B", 3, 2.0, 4, "Quick summaries and column guesses"],
      ["llama3.2:1b", "Llama 3.2 1B", 1, 1.3, 2, "Fastest; very limited"],
    ];
    const status: AiStatus = {
      hardware: { os: "macos", arch: "aarch64", chip: "Apple M4 Pro", cpuCores: 12, memoryGb: 24, unifiedMemory: true, usableModelGb },
      ollama: { installed: true, running: true, version: "0.6.2", endpoint: "http://127.0.0.1:11434", binaryPath: "/opt/homebrew/bin/ollama", models: installed },
      mcp: {
        built: true,
        binaryPath: "/Users/me/code/plinth/target/release/plinth-mcp",
        buildable: true,
        clients: [
          { id: "claude-desktop", name: "Claude Desktop", configPath: "~/Library/Application Support/Claude/claude_desktop_config.json", available: true, registered: mockMcpRegistered.has("claude-desktop") },
          { id: "claude-code", name: "Claude Code", configPath: "~/.claude.json", available: true, registered: mockMcpRegistered.has("claude-code") },
        ],
      },
      models: catalogue.map(([name, label, paramsB, downloadGb, needsGb, note]) => ({
        name,
        label,
        paramsB,
        downloadGb,
        needsGb,
        fits: usableModelGb >= needsGb,
        installed: mockOllamaModels.includes(name),
        note,
      })),
      pulling: mockPull,
    };
    return status;
  },

  async ai_ollama_install(): Promise<AiActionResult> {
    await delay(400);
    return { ok: true, message: "Ollama is already installed." };
  },

  async ai_ollama_start(): Promise<AiActionResult> {
    await delay(400);
    return { ok: true, message: "Ollama is already running." };
  },

  async ai_model_pull({ model }): Promise<AiActionResult> {
    await latency();
    mockPull = { model, done: false, ok: false, message: "Downloading…" };
    setTimeout(() => {
      mockOllamaModels.push(model);
      mockPull = { model, done: true, ok: true, message: "Ready." };
    }, 6000);
    return { ok: true, message: `Pulling ${model} — this can take a few minutes.` };
  },

  async ai_ask({ model, prompt, history, context }): Promise<AiAnswer> {
    await delay(900);
    lastAskContext = context;
    // Mirrors the real schema-constrained reply: prose, one statement, tables.
    if (/\b(delete|drop|truncate|wipe|remove all)\b/i.test(prompt)) {
      return {
        text: "That empties the table — you'll be asked to confirm before it runs.",
        sql: "DELETE FROM events;",
        tables: ["main.events"],
        durationMs: 700,
      };
    }
    if (/\b(select|count|how many|list|show|rows?|table|sum|avg|group)\b/i.test(prompt)) {
      return {
        text: "This reads the newest rows first — events is the only table here with a timestamp.",
        sql: "SELECT id, name, value, at\nFROM events\nORDER BY at DESC",
        tables: ["main.events"],
        durationMs: 900,
      };
    }
    return {
      text: `Hello — I can see this database's tables. (Mock answer from ${model}, turn ${history.length / 2 + 1}.)`,
      sql: null,
      tables: [],
      durationMs: 900,
    };
  },

  /** A scripted three-step loop, so the harness and its UI can be exercised. */
  async ai_step({ history }): Promise<AiStep> {
    await delay(700);
    // Count observations, not user turns: the harness appends one per executed
    // step, and a thread carries earlier questions the loop must ignore.
    const observations = history.filter((h) => h.role === "user" && h.content.startsWith("Observation:")).length;
    const asked = observations + 1;
    const question = [...history].reverse().find((h) => h.role === "user" && !h.content.startsWith("Observation:"))?.content ?? "";
    const destructive = /\b(delete|drop|truncate|wipe|remove all)\b/i.test(question);
    const base = { table: null, sql: null, answer: null, tables: [] as string[], assumptions: [] as string[], durationMs: 700 };
    if (asked === 1) return { ...base, thought: "I should look at real values before filtering on them.", action: "sample", table: "main.events" };
    if (asked === 2) return { ...base, thought: "Now check the shape of the result before committing to it.", action: "probe", sql: "SELECT name, count(*) FROM events GROUP BY name" };
    if (destructive) {
      return { ...base, thought: "This asks for a deletion, which only you can run.", action: "answer", answer: "This removes every row in events. It is not run for you — pressing Run asks you to confirm first.", sql: "DELETE FROM events;", tables: ["main.events"], assumptions: ["You meant every row, not a subset"] };
    }
    return {
      ...base,
      thought: "The sample confirmed the value names; I can answer.",
      action: "answer",
      answer: "Counts the rows in events by name, newest first. I checked the actual values in `name` rather than assuming them.",
      sql: "SELECT name, count(*) AS n FROM events GROUP BY name ORDER BY n DESC",
      tables: ["main.events"],
      assumptions: ["`name` is the event type"],
    };
  },

  async ai_mcp_connect({ client }): Promise<AiActionResult> {
    await delay(600);
    mockMcpRegistered.add(client);
    return { ok: true, message: client === "claude-desktop" ? "Added to the Claude Desktop config. Restart it to pick it up." : "Registered with Claude Code (user scope)." };
  },
};

function defaultValue(c: ColDef): Cell {
  const d = c.default ?? "";
  if (/^'(.*)'$/.test(d)) return d.slice(1, -1);
  if (d === "true") return true;
  if (d === "false") return false;
  if (d === "now()") return isoAt(Date.now(), 0);
  if (/^-?\d+$/.test(d)) return c.wire === "string" ? d : Number(d);
  return null;
}

function sqlLiteral(v: Cell): string {
  if (v == null) return "NULL";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "object") return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

function statementsFor(changes: ChangeSet): string[] {
  const tn = changes.table ? `${changes.table.schema ? changes.table.schema + "." : ""}${changes.table.name}` : "?";
  const where = (pk: Record<string, Cell>) =>
    Object.entries(pk)
      .map(([k, v]) => `${k} = ${sqlLiteral(v)}`)
      .join(" AND ");
  const out: string[] = [];
  for (const u of changes.updates) out.push(`UPDATE ${tn} SET ${u.column} = ${sqlLiteral(u.value)} WHERE ${where(u.pk)};`);
  for (const i of changes.inserts) {
    const cols = Object.keys(i.values);
    out.push(`INSERT INTO ${tn} (${cols.join(", ")}) VALUES (${cols.map((c) => sqlLiteral(i.values[c])).join(", ")});`);
  }
  for (const d of changes.deletes) out.push(`DELETE FROM ${tn} WHERE ${where(d.pk)};`);
  return out;
}

// ───────────────────────── test controls ─────────────────────────

export const mockControls = {
  /** Simulate a tunnel drop: `down` now, `degraded` after 2s, `up` after 4s. */
  dropConnection(workspaceId: WorkspaceId) {
    const w = workspaces.get(workspaceId);
    const name = w?.info.connectionName ?? "connection";
    mockEmitter.emit({ type: "connection-state", workspaceId, state: "down", detail: `Tunnel to ${name} dropped — reconnecting (attempt 1)` });
    setTimeout(() => mockEmitter.emit({ type: "connection-state", workspaceId, state: "degraded", detail: `Tunnel to ${name} dropped — reconnecting (attempt 2)` }), 2000);
    setTimeout(() => mockEmitter.emit({ type: "connection-state", workspaceId, state: "up", detail: null }), 4000);
  },
  /** Push a fake AI console entry. */
  aiQuery(connectionId: ConnectionId, sql = "SELECT count(*) FROM public.orders WHERE status = 'refunded'") {
    log({ workspaceId: null, connectionId, source: "ai", sql, durationMs: 21, rows: 1, error: null });
  },
  schemaChanged(workspaceId: WorkspaceId) {
    mockEmitter.emit({ type: "schema-changed", workspaceId });
  },
  workspaceIds: () => Array.from(workspaces.keys()),
  /** Exactly what the AI pane put in front of the model on the last ask. */
  lastContext: () => lastAskContext,
};

declare global {
  interface Window {
    plinthMock?: typeof mockControls;
  }
}
if (typeof window !== "undefined") window.plinthMock = mockControls;

