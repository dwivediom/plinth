import { errorMessage, invoke } from "../ipc/client";
import type { SchemaIndex, WorkspaceId } from "../ipc/types";
import { explainSql, parsePlan } from "./explain";
import { HYPOPG, createIndexSql, indexCandidates, rank, totalCost, type Candidate, type OptimizeReport } from "./optimize";

/**
 * Running the optimiser.
 *
 * Every candidate — whether a rule derived it or the model wrote it — is put
 * back through `EXPLAIN` before anyone sees it. That is not belt and braces;
 * it is the feature. On this machine a local 8B model produced two rewrites
 * for a slow query and Postgres refused both with a syntax error, which the
 * planner reported and the UI therefore never showed. A suggestion that
 * cannot be measured is labelled as unmeasured, and one that measures worse
 * is shown as no help rather than quietly dropped.
 */

/** One statement in, one JSON cell out. */
async function oneCell(workspaceId: WorkspaceId, sql: string): Promise<{ json: string | null; error: string | null }> {
  const results = await invoke("query_run", { workspaceId, sql, limit: 1, source: "user" });
  const first = results[0];
  if (first?.error) return { json: null, error: first.error.message };
  if (!first?.cursorId) return { json: null, error: "no rows" };
  const window = await invoke("cursor_fetch", { cursorId: first.cursorId, offset: 0, len: 1 });
  void invoke("cursor_close", { cursorId: first.cursorId }).catch(() => {});
  const cell = window.rows[0]?.[0];
  return { json: typeof cell === "string" ? cell : cell == null ? null : JSON.stringify(cell), error: null };
}

/** Only to choose the wording — the measurement itself asks the driver. */
async function hasHypopg(workspaceId: WorkspaceId): Promise<boolean> {
  try {
    const r = await invoke("query_run", { workspaceId, sql: HYPOPG.probe, limit: 1, source: "user" });
    const first = r[0];
    if (first?.error || !first?.cursorId) return false;
    const w = await invoke("cursor_fetch", { cursorId: first.cursorId, offset: 0, len: 1 });
    void invoke("cursor_close", { cursorId: first.cursorId }).catch(() => {});
    const cell = w.rows[0]?.[0];
    return cell === true || cell === "t" || cell === "true";
  } catch {
    return false;
  }
}

/** Cost of the query as the planner sees it right now. */
async function costOf(workspaceId: WorkspaceId, sql: string): Promise<{ cost: number | null; json: string | null; error: string | null }> {
  const { json, error } = await oneCell(workspaceId, explainSql(sql, false));
  if (!json) return { cost: null, json: null, error };
  return { cost: totalCost(json), json, error: null };
}

export interface OptimizeOptions {
  workspaceId: WorkspaceId;
  /** The statement being optimised. */
  sql: string;
  /** Its captured plan — `EXPLAIN` or `EXPLAIN ANALYZE`, either will do. */
  planJson: string;
  schema: SchemaIndex | null;
  /** Ollama model id, or null to skip the rewrite half entirely. */
  model: string | null;
  /** Called as each step finishes, so the UI can show progress. */
  onProgress?: (what: string) => void;
}

export async function runOptimize(opts: OptimizeOptions): Promise<OptimizeReport> {
  const { workspaceId, sql, planJson, schema, model, onProgress } = opts;
  const plan = parsePlan(planJson);
  const candidates: Candidate[] = [];
  let refused = 0;

  onProgress?.("Reading the plan");
  // The captured plan may be an ANALYZE run; costs must be compared against a
  // plain EXPLAIN of the same statement, which is what each candidate is
  // measured against too.
  const base = await costOf(workspaceId, sql);
  const baseCost = base.cost ?? totalCost(planJson) ?? 0;

  const hypopg = await hasHypopg(workspaceId);
  const indexes = plan ? indexCandidates(plan, schema) : [];

  for (const c of indexes) {
    const ddl = createIndexSql(c);
    const candidate: Candidate = {
      id: `idx:${c.relation}:${c.columns.join(",")}`,
      kind: "index",
      title: `Index ${c.relation} (${c.columns.join(", ")})`,
      sql: ddl,
      why: c.reason,
      source: "plan",
      baseCost,
      newCost: null,
      used: null,
    };
    if (!hypopg) {
      candidate.note = "Not measured — install the hypopg extension and Plinth will test it against the planner without building it.";
      candidates.push(candidate);
      continue;
    }
    onProgress?.(`Testing ${candidate.title}`);
    try {
      // One connection for reset → create → plan → reset: a hypothetical
      // index lives in a session, and a pool would hand the EXPLAIN to a
      // connection that never heard of it.
      const json = await invoke("explain_hypothetical", { workspaceId, sql, indexes: [ddl] });
      candidate.newCost = totalCost(json);
      // Did the planner actually reach for it? An index it ignores would have
      // cost disk for nothing.
      candidate.used = /hypopg|<\d+>btree/i.test(json);
    } catch (e) {
      candidate.note = errorMessage(e);
    }
    candidates.push(candidate);
  }

  // ── the model's half, always measured, never taken on trust
  if (model) {
    onProgress?.("Asking the model for a rewrite");
    try {
      const worst = plan?.hazards[0];
      const answer = await invoke("ai_ask", {
        model,
        prompt:
          `Rewrite this PostgreSQL query so the planner does less work, returning exactly the same rows. ` +
          `Do not suggest indexes. If no rewrite would help, say so and give no SQL.\n\n` +
          `The plan's problem: ${worst ? `${worst.title} — ${worst.detail}` : "no single node dominates"}\n\nQuery:\n${sql}`,
        context: schemaContext(schema, plan?.nodes.map((n) => n.relation).filter(Boolean) as string[]),
        history: [],
      });
      if (answer.sql) {
        onProgress?.("Measuring the rewrite");
        const after = await costOf(workspaceId, answer.sql);
        // A rewrite the server will not even parse is not advice. Small local
        // models produce these often; the count is reported, the SQL is not.
        if (after.error) refused += 1;
        else candidates.push({
          id: "rewrite:model",
          kind: "rewrite",
          title: "Rewritten query",
          sql: answer.sql,
          why: answer.text.split("\n")[0] || "Proposed by the model.",
          source: "model",
          baseCost,
          newCost: after.cost,
          used: null,
        });
      }
    } catch {
      /* the model is optional; the rules are not */
    }
  }

  return {
    baseCost,
    bottleneck: plan?.hazards[0]?.title ?? null,
    hypopg,
    candidates: rank(candidates),
    refusedRewrites: refused,
    ranAt: new Date().toISOString(),
  };
}

/** Just the tables in the plan, so a small model is not handed the database. */
function schemaContext(schema: SchemaIndex | null, relations: string[]): string {
  if (!schema) return "";
  const want = new Set(relations.map((r) => r.toLowerCase()));
  const byTable = new Map<string, string[]>();
  for (const c of schema.columns) {
    if (!want.has(c.table.toLowerCase())) continue;
    const key = `${c.schema}.${c.table}`;
    byTable.set(key, [...(byTable.get(key) ?? []), c.column]);
  }
  return [...byTable].map(([t, cols]) => `${t}(${cols.join(", ")})`).join("\n");
}
