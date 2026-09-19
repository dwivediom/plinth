import type { SchemaIndex } from "../ipc/types";
import type { ParsedPlan, PlanNode } from "./explain";

/**
 * Candidates for making a query faster.
 *
 * The rule this follows, which is the whole reason it can be trusted: **the
 * app proposes, the planner decides.** Candidates are derived from the plan
 * by arithmetic and from the model by suggestion, and then every one of them
 * is put back through `EXPLAIN` and scored. A candidate that does not lower
 * the planner's cost is shown as not helping, however confident the sentence
 * that produced it sounded.
 *
 * Two kinds:
 *   • **index** — built from the predicates the plan itself reports. Measured
 *     for real when HypoPG is installed (a hypothetical index the planner can
 *     see but nobody has to build); otherwise offered with the arithmetic
 *     that motivated it and labelled as unmeasured.
 *   • **rewrite** — from the local model, and always measurable, because
 *     `EXPLAIN` on a rewritten SELECT works on every server.
 *
 * HypoPG's own limitation matters here: hypothetical indexes are invisible to
 * `EXPLAIN ANALYZE`, so index candidates are scored on estimated cost only.
 * The UI says "estimated" because it is.
 */

export interface IndexCandidate {
  schema: string | null;
  relation: string;
  columns: string[];
  /** What in the plan asked for it. */
  reason: string;
  /** Rows the node threw away, when that is why we are here. */
  discarded: number | null;
}

export interface Candidate {
  id: string;
  kind: "index" | "rewrite";
  title: string;
  /** The statement: `CREATE INDEX …`, or the rewritten query. */
  sql: string;
  why: string;
  source: "plan" | "model";
  /** Planner cost before and after. `null` when it could not be measured. */
  baseCost: number;
  newCost: number | null;
  /** Did the planner actually take the hypothetical index? */
  used: boolean | null;
  note?: string;
}

export interface OptimizeReport {
  baseCost: number;
  /** The hazard the plan is dominated by, if there is one. */
  bottleneck: string | null;
  hypopg: boolean;
  candidates: Candidate[];
  /** Rewrites the server refused to parse. Counted, never shown as advice. */
  refusedRewrites: number;
  ranAt: string;
}

const DIRECTION = /\s+(?:ASC|DESC|NULLS\s+(?:FIRST|LAST))\b/gi;
const KEYWORDS = new Set(["and", "or", "not", "case", "when", "then", "else", "end", "any", "all", "array", "null", "true", "false", "is", "in", "like", "ilike", "between"]);

/**
 * Columns a predicate expression tests, and whether the test is an equality —
 * equality columns belong first in a composite index.
 *
 * Postgres prints predicates with casts and qualified names, e.g.
 * `((o.placed_at >= now()) AND (o.status = 'paid'::text))`.
 */
export function predicateColumns(expr: string): { column: string; equality: boolean }[] {
  const out: { column: string; equality: boolean }[] = [];
  const re = /(?:\b([A-Za-z_]\w*)\.)?\b([A-Za-z_]\w*)\b\s*(?:::[A-Za-z_][\w ]*)?\s*(=|<>|!=|<=|>=|<|>|~~\*?|~\*?)/g;
  for (const m of expr.matchAll(re)) {
    const column = m[2];
    if (KEYWORDS.has(column.toLowerCase())) continue;
    // A function call is not a column: `lower(email) = …` indexes differently
    // (an expression index), which is not something to suggest blind.
    const after = expr.slice(m.index + m[0].length - m[3].length);
    const before = expr.slice(0, m.index + m[0].length - m[3].length);
    if (/\(\s*$/.test(before.slice(0, before.length - m[0].length + m[3].length + column.length))) continue;
    if (new RegExp(`\\b${column}\\s*\\(`).test(expr)) continue;
    void after;
    out.push({ column, equality: m[3] === "=" });
  }
  return out;
}

/** `"o.placed_at DESC"` → `placed_at`. */
export function sortColumns(keys: unknown): string[] {
  if (!Array.isArray(keys)) return [];
  return keys
    .map((k) => String(k).replace(DIRECTION, "").trim())
    .map((k) => (k.includes(".") ? k.slice(k.lastIndexOf(".") + 1) : k))
    .filter((k) => /^[A-Za-z_]\w*$/.test(k));
}

/** Only columns the table actually has. The plan prints aliases and
 *  expressions too, and an index on something that is not a column is noise. */
function realColumns(schema: SchemaIndex | null, relation: string, wanted: string[]): string[] {
  if (!schema) return wanted;
  const have = new Set(
    schema.columns.filter((c) => c.table.toLowerCase() === relation.toLowerCase()).map((c) => c.column.toLowerCase()),
  );
  if (!have.size) return wanted;
  return wanted.filter((c) => have.has(c.toLowerCase()));
}

function schemaOf(schema: SchemaIndex | null, relation: string): string | null {
  const hit = schema?.columns.find((c) => c.table.toLowerCase() === relation.toLowerCase());
  return hit?.schema ?? null;
}

/**
 * Say what the scan did without implying how big the table is.
 *
 * These counts are per run, and a node runs more than once whenever it is a
 * parallel worker's share or the inner side of a nested loop. 25,000 rows
 * discarded on each of three runs is 75,000 rows of work, but it is not a
 * 75,000-row table, and a sentence that reads that way is one people stop
 * trusting.
 */
function scanReason(n: PlanNode, removed: number | null, kept: number | null): string {
  const head = `${n.type} on ${n.relation}`;
  if (removed == null || removed <= 0) return `${head} applies this filter while scanning`;
  const read = removed + (kept ?? 0);
  // `loops` is "how many times this node ran": once per parallel worker, or
  // once per row of the outer side of a nested loop. Both are runs; calling
  // them parallel workers would be wrong half the time.
  const each = n.loops > 1 ? `, on each of ${Math.round(n.loops).toLocaleString()} runs` : "";
  return `${head} read ${Math.round(read).toLocaleString()} rows and kept ${Math.round(kept ?? 0).toLocaleString()}${each} — the filter is doing work an index could do`;
}

const SCAN_TYPES = new Set(["Seq Scan", "Parallel Seq Scan", "Bitmap Heap Scan", "Index Scan", "Index Only Scan"]);

/**
 * Index candidates, from what the plan says it did — not from reading the SQL.
 * The plan is the truth about which predicate was applied where.
 */
export function indexCandidates(plan: ParsedPlan, schema: SchemaIndex | null): IndexCandidate[] {
  const out: IndexCandidate[] = [];
  const seen = new Set<string>();

  const push = (node: PlanNode, columns: string[], reason: string) => {
    const relation = node.relation;
    if (!relation || !columns.length) return;
    const cols = realColumns(schema, relation, columns).slice(0, 3);
    if (!cols.length) return;
    const key = `${relation}(${cols.join(",")})`;
    if (seen.has(key)) return;
    seen.add(key);
    const removed = node.detail["Rows Removed by Filter"];
    out.push({
      schema: schemaOf(schema, relation),
      relation,
      columns: cols,
      reason,
      discarded: typeof removed === "number" ? removed * node.loops : null,
    });
  };

  for (const n of plan.nodes) {
    const d = n.detail;
    const filter = typeof d["Filter"] === "string" ? d["Filter"] : null;
    const joinCond = ["Hash Cond", "Merge Cond", "Join Filter"].map((k) => d[k]).find((v) => typeof v === "string") as string | undefined;

    // A scan that reads rows to throw them away is the classic index shape.
    if (filter && SCAN_TYPES.has(n.type)) {
      const cols = predicateColumns(filter);
      // Equality first, then range: the order a composite index has to be in
      // for both halves of `status = 'paid' AND placed_at >= …` to be used.
      const ordered = [...cols.filter((c) => c.equality), ...cols.filter((c) => !c.equality)].map((c) => c.column);
      const perRun = typeof d["Rows Removed by Filter"] === "number" ? d["Rows Removed by Filter"] : null;
      const keptPerRun = typeof d["Actual Rows"] === "number" ? d["Actual Rows"] : null;
      push(n, [...new Set(ordered)], scanReason(n, perRun, keptPerRun));
    }

    // The inner side of a nested loop, run over and over, is the other one.
    if (joinCond && n.loops > 1 && n.relation) {
      push(n, [...new Set(predicateColumns(joinCond).map((c) => c.column))], `Ran ${Math.round(n.loops).toLocaleString()} times as the inner side of a join`);
    }

    // A sort that spilled is worth an index on its key.
    if (n.type === "Sort" && String(d["Sort Space Type"] ?? "").toLowerCase() === "disk") {
      const child = n.children[0];
      if (child?.relation) push(child, sortColumns(d["Sort Key"]), "The sort spilled to disk; an index in this order avoids it");
    }
  }
  return out;
}

/** `CREATE INDEX ON public.orders (status, placed_at)` — never `CONCURRENTLY`
 *  behind someone's back, and never a name we invented that might collide. */
export function createIndexSql(c: IndexCandidate): string {
  const table = c.schema ? `${c.schema}.${c.relation}` : c.relation;
  return `CREATE INDEX ON ${table} (${c.columns.join(", ")});`;
}

/** Whether the stronger, measured mode is available. Creating and planning
 *  with a hypothetical index happens on one pinned connection in the driver;
 *  this is only asked so the UI knows which sentence to write. */
export const HYPOPG = {
  probe: "SELECT count(*) > 0 AS present FROM pg_extension WHERE extname = 'hypopg';",
};

/** The planner's own number for a plan, for before/after. */
export function totalCost(planJson: string): number | null {
  try {
    const parsed = JSON.parse(planJson);
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    const cost = first?.Plan?.["Total Cost"];
    return typeof cost === "number" ? cost : null;
  } catch {
    return null;
  }
}

/** A change worth showing. Below this it is planner noise. */
export const MATERIAL = 0.1;

export function improvement(base: number, next: number | null): number | null {
  if (next == null || base <= 0) return null;
  return (base - next) / base;
}

/**
 * How much cheaper, in the units a person would use.
 *
 * A big win reads as a multiple — "938× cheaper" — because at that end
 * percentages all round to 100 and stop carrying information.
 */
export function describeGain(base: number, next: number | null): string | null {
  if (next == null || base <= 0) return null;
  if (next <= 0) return "planner cost near zero";
  const ratio = base / next;
  if (ratio >= 2) return `${ratio >= 10 ? Math.round(ratio).toLocaleString() : ratio.toFixed(1)}× cheaper`;
  const pct = Math.round((1 - next / base) * 100);
  return pct >= 1 ? `${pct}% cheaper` : "no improvement";
}

/** Sort by measured improvement, then by the ones we could not measure. */
export function rank(candidates: Candidate[]): Candidate[] {
  return [...candidates].sort((a, b) => {
    const ia = improvement(a.baseCost, a.newCost) ?? -1;
    const ib = improvement(b.baseCost, b.newCost) ?? -1;
    return ib - ia;
  });
}
