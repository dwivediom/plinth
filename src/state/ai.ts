import { create } from "zustand";
import { errorMessage, invoke } from "../ipc/client";
import type { AiActionResult, AiStatus, ModelOption, SchemaGraph, TableSchema } from "../ipc/types";
import { joinClause, joinsFor } from "../lib/graph";
import type { RunStep } from "../lib/agent";
import type { TableEntry } from "../lib/mentions";

const ENGINE_KEY = "ai.engine";
const MODE_KEY = "ai.mode";

/**
 * One selection covers both ways of answering: a local Ollama model
 * (`ollama:<tag>`) or an MCP client that queries Plinth from its own app
 * (`mcp:<clientId>`). The inspector pane and the settings sheet share it.
 */
export type Engine = { kind: "ollama"; model: string } | { kind: "mcp"; client: string } | null;

export function parseEngine(value: string): Engine {
  const i = value.indexOf(":");
  if (i < 0) return null;
  const rest = value.slice(i + 1);
  if (value.startsWith("ollama:")) return { kind: "ollama", model: rest };
  if (value.startsWith("mcp:")) return { kind: "mcp", client: rest };
  return null;
}

/** The best model already pulled, else the best that fits, else a client. */
function defaultEngine(s: AiStatus): string {
  const byParams = (a: ModelOption, b: ModelOption) => b.paramsB - a.paramsB;
  const pulled = s.models.filter((m) => m.installed && m.fits).sort(byParams)[0];
  if (pulled) return `ollama:${pulled.name}`;
  const registered = s.mcp.clients.find((c) => c.registered);
  if (registered) return `mcp:${registered.id}`;
  const fits = s.models.filter((m) => m.fits).sort(byParams)[0];
  return fits ? `ollama:${fits.name}` : `mcp:${s.mcp.clients[0]?.id ?? "claude-desktop"}`;
}

/** One exchange in the chat, plus any query tabs its SQL blocks opened. */
export interface Turn {
  id: string;
  q: string;
  a: string;
  /** The statement the model offered, already separated from the prose. */
  sql: string | null;
  tables: string[];
  ms: number;
  failed: boolean;
  /** The query tab this turn's SQL was run in, once it has been. */
  runTabId: string | null;
  /** What the harness did before answering — inspect, sample, probe. */
  steps: RunStep[];
  assumptions: string[];
  /** What running the answer's SQL small actually did. */
  verification: { ok: boolean; note: string } | null;
}

/** Auto runs the read-only steps as they come; manual asks first. Neither
 *  can write — that is the person's decision, every time. */
export type AgentMode = "auto" | "manual";

interface AiSetupState {
  status: AiStatus | null;
  engine: string;
  /** The id of the action in flight, so one button at a time shows progress. */
  busy: string | null;
  note: { ok: boolean; text: string } | null;
  /** Per workspace, so each database keeps its own conversation. */
  threads: Record<string, Turn[]>;
  /** Tables pinned into the context, as `schema.name`. */
  pins: Record<string, string[]>;
  /** Column detail for pinned tables, keyed `workspaceId\u0000schema.name`. */
  details: Record<string, TableSchema>;
  mode: AgentMode;
  setMode(mode: AgentMode): void;
  probe(): Promise<AiStatus | null>;
  setEngine(value: string): void;
  run(id: string, fn: () => Promise<AiActionResult>): Promise<void>;
  addTurn(workspaceId: string, turn: Turn): void;
  setRun(workspaceId: string, turnId: string, tabId: string): void;
  clearThread(workspaceId: string): void;
  pin(workspaceId: string, qualified: string): void;
  unpin(workspaceId: string, qualified: string): void;
  describe(workspaceId: string, entry: TableEntry): Promise<void>;
}

let engineRestored = false;

export const useAi = create<AiSetupState>((set, get) => ({
  status: null,
  engine: "",
  busy: null,
  note: null,
  threads: {},
  pins: {},
  details: {},
  mode: "auto",

  async probe() {
    try {
      const status = await invoke("ai_probe", {});
      set({ status });
      if (!engineRestored) {
        engineRestored = true;
        const saved = await invoke("state_get", { key: ENGINE_KEY });
        const valid =
          typeof saved === "string" &&
          (status.models.some((m) => `ollama:${m.name}` === saved) || status.mcp.clients.some((c) => `mcp:${c.id}` === saved));
        set({ engine: valid ? (saved as string) : defaultEngine(status) });
        const savedMode = await invoke("state_get", { key: MODE_KEY });
        if (savedMode === "auto" || savedMode === "manual") set({ mode: savedMode });
      }
      return status;
    } catch (e) {
      set({ note: { ok: false, text: errorMessage(e) } });
      return null;
    }
  },

  setEngine(engine) {
    set({ engine });
    void invoke("state_set", { key: ENGINE_KEY, value: engine });
  },

  setMode(mode) {
    set({ mode });
    void invoke("state_set", { key: MODE_KEY, value: mode });
  },

  addTurn(workspaceId, turn) {
    set((s) => ({ threads: { ...s.threads, [workspaceId]: [...(s.threads[workspaceId] ?? []), turn] } }));
  },

  setRun(workspaceId, turnId, tabId) {
    set((s) => ({
      threads: {
        ...s.threads,
        [workspaceId]: (s.threads[workspaceId] ?? []).map((t) => (t.id === turnId ? { ...t, runTabId: tabId } : t)),
      },
    }));
  },

  clearThread(workspaceId) {
    set((s) => ({ threads: { ...s.threads, [workspaceId]: [] } }));
  },

  pin(workspaceId, qualified) {
    set((s) => {
      const list = s.pins[workspaceId] ?? [];
      return list.includes(qualified) ? s : { pins: { ...s.pins, [workspaceId]: [...list, qualified] } };
    });
  },

  unpin(workspaceId, qualified) {
    set((s) => ({ pins: { ...s.pins, [workspaceId]: (s.pins[workspaceId] ?? []).filter((q) => q !== qualified) } }));
  },

  /** Types, keys and nullability for a pinned table — the schema index only
   *  carries column names, which isn't enough to write correct SQL. */
  async describe(workspaceId, entry) {
    const key = `${workspaceId}\u0000${entry.qualified}`;
    if (get().details[key]) return;
    try {
      const schema = await invoke("table_describe", { workspaceId, table: { schema: entry.schema, name: entry.name } });
      set((s) => ({ details: { ...s.details, [key]: schema } }));
    } catch {
      /* a table we can't describe just stays coarse in the context */
    }
  },

  async run(id, fn) {
    set({ busy: id, note: null });
    try {
      const r = await fn();
      set({ note: { ok: r.ok, text: r.message } });
      await get().probe();
    } catch (e) {
      set({ note: { ok: false, text: errorMessage(e) } });
    } finally {
      set({ busy: null });
    }
  },
}));

/**
 * What the model is told about the database. Pinned tables come first in
 * full — column types, nullability, keys — because those are what the person
 * is asking about; everything else is a one-line inventory so the model knows
 * what exists without spending the whole context on it.
 */
export function buildContext(
  index: TableEntry[],
  pinned: string[],
  details: Record<string, TableSchema>,
  workspaceId: string,
  graph: SchemaGraph | null = null,
): string {
  if (!index.length) return "";
  const out: string[] = [];
  const pinnedSet = new Set(pinned);

  for (const q of pinned) {
    const entry = index.find((e) => e.qualified === q);
    if (!entry) continue;
    const detail = details[`${workspaceId}\u0000${q}`];
    if (detail) {
      const cols = detail.columns
        .map((c) => `  ${c.name} ${c.dataType}${c.isPrimaryKey ? " PRIMARY KEY" : ""}${c.nullable ? "" : " NOT NULL"}`)
        .join("\n");
      const fks = detail.foreignKeys.map((f) => `  FOREIGN KEY (${f.columns.join(", ")}) -> ${f.refTable.schema ? `${f.refTable.schema}.` : ""}${f.refTable.name} (${f.refColumns.join(", ")})`).join("\n");
      out.push(`TABLE ${q}:\n${cols}${fks ? `\n${fks}` : ""}`);
    } else {
      out.push(`TABLE ${q}: ${entry.columns.join(", ")}`);
    }
  }

  // The join paths between the tables in play. This is the whole point of the
  // schema graph for the model: without it, a small model invents ON clauses;
  // with it, there is nothing left to invent.
  if (graph && pinned.length > 1) {
    const joins = joinsFor(graph, pinned);
    if (joins.length) {
      out.push(
        "How these tables join:\n" +
          joins.map((j) => `  ${joinClause(j)}${j.inferred ? "   -- inferred from naming, not a declared constraint" : ""}`).join("\n"),
      );
    }
  }

  const rest = index.filter((e) => !pinnedSet.has(e.qualified)).slice(0, 120);
  if (rest.length) {
    out.push(
      `Other objects in this database:\n` +
        rest.map((e) => `  ${e.qualified} (${e.kind}${e.rowEstimate != null ? `, ~${e.rowEstimate} rows` : ""}): ${e.columns.slice(0, 30).join(", ")}`).join("\n"),
    );
  }
  return out.join("\n\n").slice(0, 12000);
}
