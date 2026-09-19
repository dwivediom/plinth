/**
 * Postgres query plans, read locally.
 *
 * A plan is already JSON and the rules are arithmetic, so there is no reason
 * for anyone's schema to be uploaded to a website to answer "why is this
 * slow". Everything here is a pure function over `EXPLAIN (FORMAT JSON)`.
 *
 * Two subtleties decide whether the picture tells the truth:
 *   • times are **per loop** — a node's real cost is time × loops
 *   • a node's own cost is **self** time: inclusive minus its children
 * Colouring by inclusive time paints the root red every time and says nothing.
 */

export type Severity = "serious" | "warn" | "info";

export interface Hazard {
  id: string;
  severity: Severity;
  title: string;
  /** One sentence a person can act on. */
  detail: string;
  nodeId: string;
}

export interface PlanNode {
  id: string;
  type: string;
  /** `Seq Scan on orders`, `Hash Join`, … */
  label: string;
  relation: string | null;
  /** Total time across every loop, in ms. */
  inclusiveMs: number;
  /** This node's own share, children subtracted. */
  selfMs: number;
  /** Rows actually produced, across every loop. */
  rows: number | null;
  plannedRows: number;
  loops: number;
  /** How far the planner's estimate was out, as a ratio ≥ 1. */
  estimateFactor: number | null;
  detail: Record<string, unknown>;
  children: PlanNode[];
}

export interface ParsedPlan {
  root: PlanNode;
  nodes: PlanNode[];
  analyzed: boolean;
  planningMs: number | null;
  executionMs: number | null;
  totalMs: number;
  hazards: Hazard[];
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Fields worth putting on the card's second line. */
function describe(raw: Record<string, unknown>): { label: string; relation: string | null } {
  const type = String(raw["Node Type"] ?? "Node");
  const relation = (raw["Relation Name"] as string | undefined) ?? null;
  const index = raw["Index Name"] as string | undefined;
  const cte = raw["CTE Name"] as string | undefined;
  if (index) return { label: `${type} · ${index}`, relation: relation ?? index };
  if (relation) return { label: `${type} · ${relation}`, relation };
  if (cte) return { label: `${type} · ${cte}`, relation: cte };
  const join = raw["Join Type"] as string | undefined;
  return { label: join && type.includes("Join") ? `${join} ${type}` : type, relation: null };
}

function build(raw: Record<string, unknown>, path: string): PlanNode {
  const children = ((raw["Plans"] as Record<string, unknown>[] | undefined) ?? []).map((c, i) => build(c, `${path}.${i}`));
  const loops = num(raw["Actual Loops"]) ?? 1;
  // Per-loop average × loops is the real cost. Missing it is the single most
  // common way a plan viewer lies about a nested loop.
  const inclusiveMs = (num(raw["Actual Total Time"]) ?? 0) * loops;
  const childTime = children.reduce((a, c) => a + c.inclusiveMs, 0);
  const rows = num(raw["Actual Rows"]) != null ? (num(raw["Actual Rows"]) as number) * loops : null;
  const plannedRows = (num(raw["Plan Rows"]) ?? 0) * loops;
  const estimateFactor =
    rows == null || plannedRows <= 0
      ? null
      : Math.max(rows, plannedRows) / Math.max(1, Math.min(rows, plannedRows));

  const { label, relation } = describe(raw);
  return {
    id: path,
    type: String(raw["Node Type"] ?? "Node"),
    label,
    relation,
    inclusiveMs,
    selfMs: Math.max(0, inclusiveMs - childTime),
    rows,
    plannedRows,
    loops,
    estimateFactor,
    detail: raw,
    children,
  };
}

function flatten(node: PlanNode, out: PlanNode[] = []): PlanNode[] {
  out.push(node);
  for (const c of node.children) flatten(c, out);
  return out;
}

const SEQ_SCAN_ROWS = 50_000;
const ESTIMATE_FACTOR = 100;
const HOT_LOOPS = 1_000;
const DISCARD_RATIO = 10;
const DOMINANT_SHARE = 0.4;

/** Rules, not judgement: each one is arithmetic over fields the plan carries. */
function hazardsFor(nodes: PlanNode[], totalMs: number, analyzed: boolean): Hazard[] {
  const out: Hazard[] = [];
  const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));

  for (const n of nodes) {
    const d = n.detail;

    if (n.type === "Seq Scan" && (n.rows ?? n.plannedRows) >= SEQ_SCAN_ROWS) {
      out.push({
        id: `${n.id}-seq`,
        severity: "serious",
        title: "Sequential scan",
        detail: `${n.relation ?? "This table"} is read end to end — ${fmt(n.rows ?? n.plannedRows)} rows. An index on the filtered column would let it skip most of them.`,
        nodeId: n.id,
      });
    }

    if (analyzed && n.estimateFactor != null && n.estimateFactor >= ESTIMATE_FACTOR) {
      const over = (n.rows ?? 0) > n.plannedRows;
      out.push({
        id: `${n.id}-estimate`,
        severity: "warn",
        title: "Planner estimate is wrong",
        detail: `Expected ${fmt(n.plannedRows)} rows, got ${fmt(n.rows ?? 0)} — ${Math.round(n.estimateFactor)}× ${over ? "more" : "fewer"}. The planner chose this shape from a bad guess; ANALYZE the table.`,
        nodeId: n.id,
      });
    }

    if (String(d["Sort Space Type"] ?? "").toLowerCase() === "disk") {
      const kb = num(d["Sort Space Used"]);
      out.push({
        id: `${n.id}-sort`,
        severity: "serious",
        title: "Sort spilled to disk",
        detail: `This sort needed ${kb ? `${fmt(kb)} kB, more` : "more"} than work_mem allows, so it went to disk (${String(d["Sort Method"] ?? "external")}). Raising work_mem for this session keeps it in memory.`,
        nodeId: n.id,
      });
    }

    const batches = num(d["Hash Batches"]);
    if (batches != null && batches > 1) {
      out.push({
        id: `${n.id}-hash`,
        severity: "warn",
        title: "Hash spilled to disk",
        detail: `The hash was split into ${batches} batches because it did not fit in work_mem, so the join re-read from disk.`,
        nodeId: n.id,
      });
    }

    if (n.loops >= HOT_LOOPS) {
      out.push({
        id: `${n.id}-loops`,
        severity: "warn",
        title: "Run many times",
        detail: `This node ran ${fmt(n.loops)} times, not once — ${n.inclusiveMs.toFixed(1)} ms in total. That is the inner side of a nested loop; an index on the join column usually collapses it.`,
        nodeId: n.id,
      });
    }

    const removed = num(d["Rows Removed by Filter"]);
    if (removed != null && n.rows != null && removed >= Math.max(1, n.rows) * DISCARD_RATIO) {
      out.push({
        id: `${n.id}-filter`,
        severity: "warn",
        title: "Filter threw most rows away",
        detail: `Read ${fmt(removed + n.rows)} rows to return ${fmt(n.rows)} — ${Math.round(removed / Math.max(1, n.rows))}× waste. This is the shape an index is for.`,
        nodeId: n.id,
      });
    }
  }

  const dominant = [...nodes].sort((a, b) => b.selfMs - a.selfMs)[0];
  if (analyzed && dominant && totalMs > 0 && dominant.selfMs / totalMs >= DOMINANT_SHARE) {
    out.push({
      id: `${dominant.id}-dominant`,
      severity: "info",
      title: "Where the time goes",
      detail: `${dominant.label} is ${Math.round((dominant.selfMs / totalMs) * 100)}% of the run on its own (${dominant.selfMs.toFixed(1)} ms). Everything else is noise until this changes.`,
      nodeId: dominant.id,
    });
  }

  const order: Record<Severity, number> = { serious: 0, warn: 1, info: 2 };
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}

/** Parse `EXPLAIN (FORMAT JSON)` output — the array Postgres returns, or its text. */
export function parsePlan(input: string | unknown): ParsedPlan | null {
  let json: unknown = input;
  if (typeof input === "string") {
    try {
      json = JSON.parse(input);
    } catch {
      return null;
    }
  }
  const first = Array.isArray(json) ? json[0] : json;
  if (!first || typeof first !== "object") return null;
  const wrapper = first as Record<string, unknown>;
  const planRaw = wrapper["Plan"] as Record<string, unknown> | undefined;
  if (!planRaw) return null;

  const root = build(planRaw, "n");
  const nodes = flatten(root);
  const analyzed = num(planRaw["Actual Total Time"]) != null;
  const executionMs = num(wrapper["Execution Time"]);
  const planningMs = num(wrapper["Planning Time"]);
  const totalMs = executionMs ?? root.inclusiveMs;

  return { root, nodes, analyzed, planningMs, executionMs, totalMs, hazards: hazardsFor(nodes, totalMs, analyzed) };
}

/** The fields worth showing in the side panel, in a sensible order. */
export const DETAIL_FIELDS = [
  "Relation Name",
  "Alias",
  "Index Name",
  "Index Cond",
  "Filter",
  "Rows Removed by Filter",
  "Join Type",
  "Hash Cond",
  "Sort Key",
  "Sort Method",
  "Sort Space Used",
  "Sort Space Type",
  "Hash Batches",
  "Group Key",
  "Startup Cost",
  "Total Cost",
  "Plan Rows",
  "Actual Rows",
  "Actual Loops",
  "Shared Hit Blocks",
  "Shared Read Blocks",
  "Temp Read Blocks",
  "Temp Written Blocks",
  "Workers Launched",
];

export function formatMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  if (ms >= 1) return `${ms.toFixed(1)} ms`;
  return `${ms.toFixed(3)} ms`;
}

export function formatRows(n: number | null): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

/** Wrap a statement for EXPLAIN. `analyze` executes it — the caller must have
 *  checked that the statement is read-only first. */
export function explainSql(sql: string, analyze: boolean): string {
  const body = sql.trim().replace(/;\s*$/, "");
  return analyze ? `EXPLAIN (ANALYZE, FORMAT JSON, BUFFERS) ${body}` : `EXPLAIN (FORMAT JSON) ${body}`;
}
