import { errorMessage, invoke } from "../ipc/client";
import type { AiStep, Cell, ChatTurn, ColumnDesc, QueryResult, TableRef } from "../ipc/types";
import { cellText } from "./format";

/** Six steps is enough to inspect, sample, probe and answer — and short
 *  enough that a confused model cannot spend your afternoon. */
export const STEP_BUDGET = 6;
const SAMPLE_ROWS = 5;
const MAX_OBSERVATION = 1500;
const MAX_CELL = 40;

export type StepStatus = "proposed" | "running" | "done" | "skipped" | "failed";

export interface RunStep {
  id: string;
  step: AiStep;
  status: StepStatus;
  observation?: string;
}

export interface AgentResult {
  answer: string;
  sql: string | null;
  tables: string[];
  assumptions: string[];
  steps: RunStep[];
  /** What running the answer's SQL with a LIMIT actually did, when it was read-only. */
  verification: { ok: boolean; note: string } | null;
}

export interface AgentOptions {
  workspaceId: string;
  model: string;
  context: string;
  question: string;
  /** Earlier exchanges, so a follow-up is not a cold start. */
  history: ChatTurn[];
  mode: "auto" | "manual";
  onSteps(steps: RunStep[]): void;
  /** Manual mode: resolve true to run the proposed step, false to skip it. */
  approve(step: RunStep): Promise<boolean>;
  cancelled(): boolean;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function table(columns: ColumnDesc[], rows: Cell[][]): string {
  const head = columns.map((c) => c.name).join(" | ");
  const body = rows.map((r) => r.map((v, i) => truncate(cellText(v, columns[i]?.logical ?? "text"), MAX_CELL)).join(" | ")).join("\n");
  return truncate(`${head}\n${body}`, MAX_OBSERVATION);
}

function parseTable(name: string): TableRef {
  const i = name.lastIndexOf(".");
  return i > 0 ? { schema: name.slice(0, i), name: name.slice(i + 1) } : { schema: null, name };
}

/** Rows for a result that came back with a cursor. Always closes it. */
async function rows(result: QueryResult, limit: number): Promise<Cell[][]> {
  if (!result.cursorId) return [];
  try {
    const window = await invoke("cursor_fetch", { cursorId: result.cursorId, offset: 0, len: limit });
    return window.rows;
  } finally {
    void invoke("cursor_close", { cursorId: result.cursorId }).catch(() => {});
  }
}

// ───────────────────────── the tools ─────────────────────────
// Every one of them is read-only. There is no write tool, so no prompt can
// talk the model into one — the person is the only path to a write.

async function inspect(workspaceId: string, name: string): Promise<string> {
  const schema = await invoke("table_describe", { workspaceId, table: parseTable(name) });
  const cols = schema.columns
    .map((c) => `  ${c.name} ${c.dataType}${c.isPrimaryKey ? " PRIMARY KEY" : ""}${c.nullable ? "" : " NOT NULL"}`)
    .join("\n");
  const fks = schema.foreignKeys
    .map((f) => `  FOREIGN KEY (${f.columns.join(", ")}) -> ${f.refTable.schema ? `${f.refTable.schema}.` : ""}${f.refTable.name} (${f.refColumns.join(", ")})`)
    .join("\n");
  return truncate(`${name}:\n${cols}${fks ? `\n${fks}` : ""}${schema.rowEstimate != null ? `\n  ~${schema.rowEstimate} rows` : ""}`, MAX_OBSERVATION);
}

async function sample(workspaceId: string, name: string): Promise<string> {
  const result = await invoke("table_open", {
    workspaceId,
    table: parseTable(name),
    query: { filters: [], sort: [], limit: SAMPLE_ROWS, offset: 0 },
  });
  const data = await rows(result, SAMPLE_ROWS);
  if (!data.length) return `${name} is empty.`;
  return `${SAMPLE_ROWS} rows from ${name}:\n${table(result.columns, data)}`;
}

async function probe(workspaceId: string, sql: string): Promise<string> {
  // The agent's own SQL goes through the same policy engine as everything
  // else, and is refused unless it is a single read-only statement.
  const check = await invoke("sql_check", { workspaceId, sql });
  if (check.statements.length !== 1) return `Refused: a probe must be exactly one statement (got ${check.statements.length}).`;
  if (!check.readOnly) return "Refused: a probe must be read-only. Only the person can run a write, from the final answer.";
  if (!check.allowed) return `Refused: ${check.statements[0]?.blockedReason ?? "blocked by this connection's policy"}.`;

  const results = await invoke("query_run", { workspaceId, sql, limit: SAMPLE_ROWS, source: "ai" });
  const first = results[0];
  if (!first) return "The probe returned nothing.";
  if (first.error) return `The probe failed: ${first.error.message}`;
  const data = await rows(first, SAMPLE_ROWS);
  if (!data.length) return "The probe ran and returned no rows.";
  return `Probe returned ${data.length} row(s):\n${table(first.columns, data)}`;
}

async function execute(workspaceId: string, step: AiStep): Promise<string> {
  switch (step.action) {
    case "inspect":
      return step.table ? inspect(workspaceId, step.table) : "No table named.";
    case "sample":
      return step.table ? sample(workspaceId, step.table) : "No table named.";
    case "probe":
      return step.sql ? probe(workspaceId, step.sql) : "No SQL given.";
    default:
      return "";
  }
}

/**
 * Ask, act, observe, repeat. The model proposes one step at a time; the
 * harness runs it and feeds back what it saw. Everything here is read-only —
 * the answer's SQL is handed to the person to run, never run for them.
 */
export async function runAgent(opts: AgentOptions): Promise<AgentResult> {
  const { workspaceId, model, context, question, mode } = opts;
  const steps: RunStep[] = [];
  const transcript: ChatTurn[] = [...opts.history, { role: "user", content: question }];
  const publish = () => opts.onSteps([...steps]);

  let answer: AgentResult = { answer: "", sql: null, tables: [], assumptions: [], steps, verification: null };

  for (let i = 0; i < STEP_BUDGET; i++) {
    if (opts.cancelled()) break;
    const step = await invoke("ai_step", { model, context, history: transcript });
    const run: RunStep = { id: `s${Date.now()}-${i}`, step, status: "proposed" };

    if (step.action === "answer") {
      run.status = "done";
      steps.push(run);
      publish();
      answer = {
        answer: step.answer ?? step.thought,
        sql: step.sql,
        tables: step.tables,
        assumptions: step.assumptions,
        steps,
        verification: null,
      };
      break;
    }

    steps.push(run);
    publish();

    if (mode === "manual" && !(await opts.approve(run))) {
      run.status = "skipped";
      run.observation = "Skipped by you.";
      publish();
      transcript.push({ role: "assistant", content: JSON.stringify(step) });
      transcript.push({ role: "user", content: "Observation: that step was skipped. Try another approach or answer." });
      continue;
    }

    run.status = "running";
    publish();
    try {
      run.observation = await execute(workspaceId, step);
      run.status = "done";
    } catch (e) {
      run.observation = `Failed: ${errorMessage(e)}`;
      run.status = "failed";
    }
    publish();
    transcript.push({ role: "assistant", content: JSON.stringify(step) });
    transcript.push({ role: "user", content: `Observation: ${run.observation}` });
  }

  if (!answer.answer && !answer.sql) {
    answer.answer = "I ran out of steps before reaching an answer. What is above is what I found.";
  }

  // Verification: run the answer's SQL small, once, and say plainly what
  // happened. This catches errors and empty results — not wrongness.
  if (answer.sql && !opts.cancelled()) {
    try {
      const check = await invoke("sql_check", { workspaceId, sql: answer.sql });
      if (check.readOnly && check.allowed && check.statements.length === 1) {
        const results = await invoke("query_run", { workspaceId, sql: answer.sql, limit: SAMPLE_ROWS, source: "ai" });
        const first = results[0];
        if (first?.error) {
          answer.verification = { ok: false, note: first.error.message };
          const retry = await invoke("ai_step", {
            model,
            context,
            history: [...transcript, { role: "user", content: `Observation: that query failed with: ${first.error.message}. Fix it and answer.` }],
          });
          if (retry.sql) {
            answer = { ...answer, answer: retry.answer ?? answer.answer, sql: retry.sql, tables: retry.tables, assumptions: retry.assumptions };
            const second = await invoke("query_run", { workspaceId, sql: retry.sql, limit: SAMPLE_ROWS, source: "ai" });
            answer.verification = second[0]?.error ? { ok: false, note: second[0].error!.message } : { ok: true, note: "runs, after one fix" };
            for (const r of second) if (r.cursorId) void invoke("cursor_close", { cursorId: r.cursorId }).catch(() => {});
          }
        } else if (first) {
          const data = await rows(first, SAMPLE_ROWS);
          answer.verification = data.length ? { ok: true, note: `runs, ${data.length} row(s) in a sample` } : { ok: false, note: "runs, but returns no rows" };
        }
      } else if (!check.readOnly) {
        answer.verification = { ok: true, note: "not run — it writes, so it needs your confirmation" };
      }
    } catch (e) {
      answer.verification = { ok: false, note: errorMessage(e) };
    }
  }

  return answer;
}
