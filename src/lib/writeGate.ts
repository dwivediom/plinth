import { invoke } from "../ipc/client";
import type { StatementCheck, WorkspaceId } from "../ipc/types";
import { askWriteGate, toast } from "../state/overlays";
import { useWorkspaces } from "../state/workspaces";

/**
 * One gate, every path.
 *
 * Whatever is about to write — something you typed, something the model
 * wrote, a saved query you re-ran — goes through here first. The policy
 * engine in Rust still has the final say; this is the part that makes sure a
 * person saw the statement before it was sent.
 *
 * Three tiers, decided by the parse rather than by a regex:
 *   • read-only            → nothing, run it
 *   • UPDATE/DELETE with a WHERE → read it and confirm
 *   • no WHERE, DDL, or unparseable → type the table's name
 */

export interface GateOutcome {
  ok: boolean;
  /** True when the engine will refuse it anyway — let it, with its own error. */
  blocked: boolean;
}

/**
 * The table a statement touches — the word you have to type to confirm it.
 *
 * Every candidate the keywords turn up is checked against a list of words
 * that are not table names, because the naive version reads
 * `CREATE INDEX ON public.orders` as a table called `ON`, and asks you to
 * type `ON` to drop your orders table. A confirmation that asks for the wrong
 * word is worse than none: it trains people to type whatever is in bold.
 */
const NOT_A_TABLE = new Set([
  "on", "if", "not", "exists", "concurrently", "unique", "index", "table", "view",
  "materialized", "only", "into", "from", "update", "set", "values", "select",
]);

export function tableFromSql(sql: string): string | null {
  const flat = sql.replace(/\s+/g, " ").trim();
  const bare = (raw: string | undefined): string | null => {
    if (!raw) return null;
    const name = raw.includes(".") ? raw.slice(raw.lastIndexOf(".") + 1) : raw;
    return !name || NOT_A_TABLE.has(name.toLowerCase()) ? null : name;
  };

  // An index is built *on* a table, and the name right after INDEX is the
  // index's own. Only trust `ON` here, where it cannot be a join condition.
  if (/\bindex\b/i.test(flat) && /\bcreate\b/i.test(flat)) {
    const on = bare(/\bon\s+["`]?([\w.]+)/i.exec(flat)?.[1]);
    if (on) return on;
  }
  // The object the statement acts on, in the order the dialects put it.
  for (const re of [
    /\b(?:from|into|update|table|truncate)\s+(?:if\s+(?:not\s+)?exists\s+)?["`]?([\w.]+)/i,
    /\b(?:view|index|sequence)\s+(?:if\s+exists\s+)?["`]?([\w.]+)/i,
  ]) {
    const hit = bare(re.exec(flat)?.[1]);
    if (hit) return hit;
  }
  return null;
}

const DESTRUCTIVE = new Set(["update", "delete", "ddl"]);

/** `4182003` → `about 4.2M`. Estimates are labelled as estimates. */
function approx(n: number): string {
  if (n >= 1_000_000) return `about ${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `about ${Math.round(n / 1_000)}k`;
  return `about ${n}`;
}

/** What introspection thinks is in there — never a number we pretend is exact. */
function rowEstimate(workspaceId: WorkspaceId, table: string | null): number | null {
  if (!table) return null;
  const schema = useWorkspaces.getState().byId[workspaceId]?.schema;
  if (!schema) return null;
  for (const s of schema.schemas) {
    for (const o of s.objects) {
      if (o.name.toLowerCase() === table.toLowerCase() && o.rowEstimate != null) return o.rowEstimate;
    }
  }
  return null;
}

function verbFor(kind: string, sql: string): string {
  if (kind === "delete") return "Delete";
  if (kind === "update") return "Update";
  if (kind !== "ddl") return "Run";
  const first = sql.trim().split(/\s+/)[0]?.toUpperCase();
  return first === "DROP" || first === "TRUNCATE" || first === "ALTER" || first === "CREATE" ? first[0] + first.slice(1).toLowerCase() : "Run";
}

/**
 * Ask, if asking is warranted. Returns false when the person said no — the
 * caller then does nothing at all, silently, because they already know why.
 *
 * `elevated` is for the run that is deliberately going around the connection's
 * policy. The policy's own refusal is expected there, so it must not short the
 * gate out: the dialog is the *only* thing left in front of the statement, and
 * it always asks.
 */
export async function guardWrite(workspaceId: WorkspaceId, sql: string, opts?: { elevated?: boolean }): Promise<GateOutcome> {
  let statements: StatementCheck[];
  let readOnly: boolean;
  try {
    const check = await invoke("sql_check", { workspaceId, sql });
    statements = check.statements;
    readOnly = check.readOnly;
  } catch {
    // The dry run is a courtesy; if it cannot be reached, the engine's own
    // policy still applies. Do not silently swallow the statement.
    return { ok: true, blocked: false };
  }
  if (!statements.length || readOnly) return { ok: true, blocked: false };

  // Safe mode and the connection's policy are both in `allowed` — the dry run
  // asks the same engine the real run will. When it says no, let the run go
  // ahead and fail: the error lands on the statement, which is where it helps.
  // An elevated run has already read that refusal and chosen to go past it, so
  // it skips ahead to the dialog instead.
  if (!opts?.elevated && statements.some((st) => !st.allowed)) return { ok: true, blocked: true };

  const writes = statements.filter((st) => !st.isExplain && DESTRUCTIVE.has(st.kind));
  const unparsed = statements.filter((st) => !st.parsed && !st.isExplain);
  if (!writes.length && !unparsed.length) return { ok: true, blocked: false };

  const serious = [...writes, ...unparsed].filter((st) => st.hasWhere === false || st.kind === "ddl" || !st.parsed);
  const first = serious[0] ?? writes[0];
  const table = tableFromSql(first.sql);
  const estimate = first.hasWhere === false ? rowEstimate(workspaceId, table) : null;
  const many = writes.length + unparsed.length > 1;

  const detail = !serious.length
    ? `It has a WHERE clause, so it affects the rows that match it${many ? ` — ${writes.length} statements in all` : ""}.`
    : !first.parsed
      ? "Plinth could not parse this, so it could not be checked. Read it once more."
      : first.kind === "ddl"
        ? "This changes the schema. It is not covered by a transaction on every server."
        : `No WHERE clause — every row in ${table ?? "the table"} is affected${estimate != null ? `, ${approx(estimate)} of them` : ""}.`;

  const ok = await askWriteGate({
    title: serious.length
      ? first.kind === "ddl"
        ? `Run this ${first.sql.trim().split(/\s+/)[0]?.toUpperCase() ?? "DDL"} on ${table ?? "the database"}?`
        : `${verbFor(first.kind, first.sql)} every row in ${table ?? "this table"}?`
      : `${verbFor(first.kind, first.sql)} rows in ${table ?? "this table"}?`,
    detail,
    statements: [...writes, ...unparsed].map((st) => st.sql),
    confirmWord: serious.length ? (table ?? "confirm") : null,
    verb: verbFor(first.kind, first.sql),
    severity: serious.length ? "danger" : "warn",
  });

  if (!ok) toast("Nothing ran.");
  return { ok, blocked: false };
}
