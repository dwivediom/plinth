import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, ChartColumn, Check, ChevronRight, Copy, FileCode, Play, ScanSearch, Square, Table2, TerminalSquare, X } from "lucide-react";
import { errorMessage, invoke } from "../../ipc/client";
import type { ChatTurn as WireTurn, SqlCheck, StatementCheck } from "../../ipc/types";
import { formatCount, formatDuration } from "../../lib/format";
import { findTable, mentionAtCaret, matchTables, mentionsIn, splitMentions, tableIndex, type TableEntry } from "../../lib/mentions";
import { runAgent, type RunStep } from "../../lib/agent";
import { buildContext, parseEngine, useAi, type Turn } from "../../state/ai";
import { useData } from "../../state/data";
import { useGraph } from "../../state/graph";
import { toast } from "../../state/overlays";
import { useWorkspaces } from "../../state/workspaces";

const NO_TURNS: Turn[] = [];
const NO_PINS: string[] = [];

/** What the harness did, in order. The observation is what it saw — kept
 *  collapsed, because the summary is usually enough and the detail is long. */
function StepList({ steps: all, pending, live }: { steps: RunStep[]; pending?: { step: RunStep; resolve: (ok: boolean) => void } | null; live?: boolean }) {
  // The answer step is the answer, rendered below — showing it here twice
  // makes the timeline look like it repeated itself.
  const steps = all.filter((s) => s.step.action !== "answer");
  if (!steps.length) return null;
  // While it is working, the steps are the content. Once there is an answer
  // they are provenance: one line, open it if you care.
  const summary = `${steps.length} step${steps.length === 1 ? "" : "s"} · ${steps.map((s) => s.step.action).join(", ")}`;
  if (!live && !pending) {
    return (
      <details className="steps-done">
        <summary>
          <ChevronRight /> {summary}
        </summary>
        <StepBody steps={steps} pending={pending} />
      </details>
    );
  }
  return <StepBody steps={steps} pending={pending} />;
}

function StepBody({ steps, pending }: { steps: RunStep[]; pending?: { step: RunStep; resolve: (ok: boolean) => void } | null }) {
  const icon = (a: RunStep["step"]["action"]) => (a === "probe" ? <TerminalSquare /> : a === "sample" ? <ScanSearch /> : <Table2 />);
  return (
    <div className="steps">
      {steps.map((s) => (
        <div className={`step ${s.status}`} key={s.id}>
          <div className="t">
            {icon(s.step.action)}
            <b>{s.step.action}</b>
            {s.step.table && <code>{s.step.table}</code>}
            {s.status === "running" && <em>running…</em>}
            {s.status === "skipped" && <em>skipped</em>}
            {s.status === "done" && <Check />}
          </div>
          {s.step.thought && <div className="why">{s.step.thought}</div>}
          {s.step.sql && <pre className="obs">{s.step.sql}</pre>}
          {s.observation && (
            <details>
              <summary>
                <ChevronRight /> what it saw
              </summary>
              <pre className="obs">{s.observation}</pre>
            </details>
          )}
          {pending?.step.id === s.id && (
            <div className="approve">
              <button className="btn default" onClick={() => pending.resolve(true)}>
                Run this step
              </button>
              <button className="btn" onClick={() => pending.resolve(false)}>
                Skip
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** The form the question implies. Only an opening guess — the chart tab has
 *  the picker, and the data decides what actually reads well. */
function chartFormFor(question: string): "bar" | "line" | "area" | "scatter" | "donut" {
  const q = question.toLowerCase();
  // If they named the chart, that is the answer — no heuristic beats being told.
  const named = /\b(bar|line|area|scatter|donut|pie)\b\s*(?:chart|graph|plot)?/.exec(q);
  if (named) return named[1] === "pie" ? "donut" : (named[1] as "bar" | "line" | "area" | "scatter" | "donut");
  if (/\b(over time|trend|per (day|week|month|year)|daily|weekly|monthly|timeline)\b/.test(q)) return "line";
  if (/\b(share|proportion|percent|split|breakdown|distribution of)\b/.test(q)) return "donut";
  if (/\b(correlat|versus|vs\.?|against|scatter)\b/.test(q)) return "scatter";
  if (/\b(cumulative|stacked|volume)\b/.test(q)) return "area";
  return "bar";
}

/** A title short enough for a tab: the verb and the first table it touches. */
function tabTitle(sql: string): string {
  const flat = sql.replace(/\s+/g, " ").trim();
  const m = flat.match(/\b(?:from|into|update|table)\s+([\w.""`[\]]+)/i);
  const verb = flat.split(" ")[0]?.toUpperCase() ?? "SQL";
  return m ? `${verb} ${m[1].replace(/["`[\]]/g, "")}` : flat.slice(0, 24);
}

export function AiChat({ workspaceId }: { workspaceId: string }) {
  const w = useWorkspaces((s) => s.byId[workspaceId]);
  const openObject = useWorkspaces((s) => s.openObject);
  const openQuery = useWorkspaces((s) => s.openQuery);
  const openChart = useWorkspaces((s) => s.openChart);
  const activateTab = useWorkspaces((s) => s.activateTab);
  const status = useAi((s) => s.status);
  const engine = useAi((s) => s.engine);
  const thread = useAi((s) => s.threads[workspaceId] ?? NO_TURNS);
  const pins = useAi((s) => s.pins[workspaceId] ?? NO_PINS);
  const details = useAi((s) => s.details);
  const addTurn = useAi((s) => s.addTurn);
  const setRun = useAi((s) => s.setRun);
  const pin = useAi((s) => s.pin);
  const unpin = useAi((s) => s.unpin);
  const describe = useAi((s) => s.describe);
  const mode = useAi((s) => s.mode);
  const setMode = useAi((s) => s.setMode);
  const graph = useGraph((s) => s.byWorkspace[workspaceId] ?? null);
  const loadGraph = useGraph((s) => s.load);

  const [text, setText] = useState("");
  const [thinking, setThinking] = useState(false);
  /** Steps of the run in flight, before it becomes a turn. */
  const [live, setLive] = useState<RunStep[]>([]);
  /** Manual mode: the step waiting on you, and the promise it is blocking. */
  const [pending, setPending] = useState<{ step: RunStep; resolve: (ok: boolean) => void } | null>(null);
  const cancelled = useRef(false);
  const [menu, setMenu] = useState<{ from: number; matches: TableEntry[]; active: number } | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const tail = useRef<HTMLDivElement>(null);

  const index = useMemo(() => tableIndex(w?.schema ?? null), [w?.schema]);
  const sel = parseEngine(engine);
  const model = sel?.kind === "ollama" ? status?.models.find((m) => m.name === sel.model) ?? null : null;
  const client = sel?.kind === "mcp" ? status?.mcp.clients.find((c) => c.id === sel.client) ?? null : null;
  const ready = sel?.kind === "ollama" && model?.installed === true && status?.ollama.running === true;

  useEffect(() => {
    tail.current?.scrollIntoView({ block: "end" });
  }, [thread, thinking]);

  // The join graph is part of the context, so fetch it with the pane.
  useEffect(() => {
    void loadGraph(workspaceId);
  }, [loadGraph, workspaceId]);

  // Pinned tables are the ones the answer will lean on — fetch their types.
  useEffect(() => {
    for (const q of pins) {
      const entry = index.find((e) => e.qualified === q);
      if (entry) void describe(workspaceId, entry);
    }
  }, [pins, index, describe, workspaceId]);

  const openTable = useCallback(
    (entry: TableEntry) => {
      openObject(workspaceId, { schema: entry.schema, name: entry.name, kind: entry.kind });
    },
    [openObject, workspaceId],
  );

  // ── sending ──

  const send = async (raw?: string) => {
    const question = (raw ?? text).trim();
    if (!question || !ready || thinking || sel?.kind !== "ollama") return;
    for (const m of mentionsIn(question, index)) pin(workspaceId, m.qualified);
    setText("");
    setMenu(null);
    setThinking(true);
    setLive([]);
    cancelled.current = false;

    const history: WireTurn[] = thread
      .filter((t) => !t.failed)
      .flatMap((t) => [{ role: "user" as const, content: t.q }, { role: "assistant" as const, content: t.a }]);
    const context = buildContext(index, [...new Set([...pins, ...mentionsIn(question, index).map((m) => m.qualified)])], details, workspaceId, graph);
    const started = performance.now();
    try {
      const result = await runAgent({
        workspaceId,
        model: sel.model,
        context,
        question,
        history,
        mode,
        onSteps: setLive,
        approve: (step) => new Promise<boolean>((resolve) => setPending({ step, resolve })),
        cancelled: () => cancelled.current,
      });
      addTurn(workspaceId, {
        id: `t${Date.now()}`,
        q: question,
        a: result.answer,
        sql: result.sql,
        tables: result.tables,
        ms: Math.round(performance.now() - started),
        failed: false,
        runTabId: null,
        steps: result.steps,
        assumptions: result.assumptions,
        verification: result.verification,
      });
    } catch (e) {
      addTurn(workspaceId, {
        id: `t${Date.now()}`,
        q: question,
        a: errorMessage(e),
        sql: null,
        tables: [],
        ms: Math.round(performance.now() - started),
        failed: true,
        runTabId: null,
        steps: [],
        assumptions: [],
        verification: null,
      });
    } finally {
      setThinking(false);
      setPending(null);
      setLive([]);
    }
  };

  // ── running, with the guardrails in front ──

  const runSql = async (turn: Turn, sql: string) => {
    let check: SqlCheck;
    try {
      check = await invoke("sql_check", { workspaceId, sql });
    } catch (e) {
      toast(errorMessage(e), "error");
      return;
    }
    if (!check.statements.length) return;
    if (check.statements.length > 1) {
      toast(`${check.statements.length} statements — open it in the editor and run them yourself.`, "error");
      return;
    }
    const st: StatementCheck = check.statements[0];
    if (!st.allowed) {
      toast(st.blockedReason ?? "Blocked by this connection's policy.", "error");
      return;
    }
    // Everything destructive meets the same gate as SQL you typed yourself:
    // the tab opens, and `guardWrite` shows the statement before it is sent.
    // One gate, one dialog, whoever wrote the SQL.
    const tabId = openQuery(workspaceId, sql, { title: tabTitle(sql), autoRun: true, source: "ai" });
    setRun(workspaceId, turn.id, tabId);
  };

  // ── composer ──

  const syncMenu = (value: string, caret: number) => {
    const at = mentionAtCaret(value, caret);
    if (!at) return setMenu(null);
    const matches = matchTables(index, at.query);
    setMenu(matches.length ? { from: at.from, matches, active: 0 } : null);
  };

  const accept = (entry: TableEntry) => {
    if (!menu) return;
    const caret = input.current?.selectionStart ?? text.length;
    const next = `${text.slice(0, menu.from)}@${entry.qualified} ${text.slice(caret)}`;
    setText(next);
    setMenu(null);
    pin(workspaceId, entry.qualified);
    requestAnimationFrame(() => {
      const pos = menu.from + entry.qualified.length + 2;
      input.current?.focus();
      input.current?.setSelectionRange(pos, pos);
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (menu) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const d = e.key === "ArrowDown" ? 1 : -1;
        setMenu({ ...menu, active: (menu.active + d + menu.matches.length) % menu.matches.length });
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        accept(menu.matches[menu.active]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMenu(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
    if (e.key === "Escape") setText("");
  };

  const hint = ready
    ? `${model?.label ?? sel?.model} · local · @ to add a table`
    : client
      ? client.registered
        ? `Ask in ${client.name} — it queries Plinth over MCP.`
        : `Connect ${client.name} in Setup, then ask there.`
      : model && !model.installed
        ? `Pull ${model.label} in Setup to ask here.`
        : "Start Ollama in Setup to ask here.";

  const suggestions = useMemo(() => {
    const first = index[0];
    return [
      "Summarise this schema in a few lines",
      first ? `How many rows are in @${first.qualified}?` : "Which tables have a timestamp column?",
      "Which tables reference each other?",
    ];
  }, [index]);

  return (
    <div className="chat">
      <div className="thread">
        {!thread.length && !thinking && (
          <div className="chat-empty">
            <p>Ask about this database. The model sees its tables and columns — type <b>@</b> to pin one into the context.</p>
            {suggestions.map((s) => (
              <button key={s} className="suggest" disabled={!ready} onClick={() => void send(s)}>
                {s}
              </button>
            ))}
          </div>
        )}
        {thread.map((t) => (
          <div className="turn" key={t.id}>
            <div className="bubble q selectable">{t.q}</div>
            <div className={`bubble a${t.failed ? " bad" : ""}`}>
              <StepList steps={t.steps} />
              <p className="selectable">
                {splitMentions(t.a, index).map((chunk, j) =>
                  "mention" in chunk ? (
                    <button key={j} className="mention" title={`Open ${chunk.mention.qualified}`} onClick={() => openTable(chunk.mention)}>
                      <Table2 /> {chunk.mention.name}
                    </button>
                  ) : (
                    <span key={j}>{chunk.text}</span>
                  ),
                )}
              </p>
              {!!t.tables.length && (
                <div className="used">
                  {t.tables.map((q) => {
                    const entry = findTable(index, q);
                    return entry ? (
                      <button key={q} className="mention" title={`Open ${entry.qualified}`} onClick={() => openTable(entry)}>
                        <Table2 /> {entry.name}
                      </button>
                    ) : null;
                  })}
                </div>
              )}
              <button className="copyans" title="Copy this answer" onClick={() => void navigator.clipboard?.writeText([t.a, t.sql].filter(Boolean).join("\n\n"))}>
                <Copy />
              </button>
              {!!t.assumptions.length && (
                <ul className="assume">
                  {t.assumptions.map((a, j) => (
                    <li key={j}>{a}</li>
                  ))}
                </ul>
              )}
              {t.sql && (
                <SqlCard
                  sql={t.sql}
                  tabId={t.runTabId}
                  onRun={() => void runSql(t, t.sql!)}
                  onOpen={() => openQuery(workspaceId, t.sql!, { title: tabTitle(t.sql!), source: "ai" })}
                  onChart={() => openChart(workspaceId, t.sql!, { title: `Chart · ${tabTitle(t.sql!)}`, form: chartFormFor(t.q) })}
                  onFocusTab={(tabId) => activateTab(workspaceId, tabId)}
                  verification={t.verification}
                />
              )}
            </div>
          </div>
        ))}
        {thinking && (
          <div className="bubble a">
            <StepList steps={live} pending={pending} live />
            {!pending && (
              <div className="thinking">
                <i /> <i /> <i />
              </div>
            )}
          </div>
        )}
        <div ref={tail} />
      </div>

      <div className="composer">
        {pins.length > 0 && (
          <div className="pins">
            {pins.map((q) => {
              const entry = index.find((e) => e.qualified === q);
              return (
                <span className="pin" key={q} title={`${q} is in the model's context`}>
                  <button className="open" onClick={() => entry && openTable(entry)}>
                    <Table2 /> {entry?.name ?? q}
                  </button>
                  <button className="rm" aria-label={`Remove ${q} from context`} onClick={() => unpin(workspaceId, q)}>
                    <X />
                  </button>
                </span>
              );
            })}
          </div>
        )}
        {menu && (
          <div className="mention-menu" role="listbox">
            {menu.matches.map((m, i) => (
              <button key={m.qualified} className={i === menu.active ? "on" : ""} role="option" aria-selected={i === menu.active} onMouseDown={(e) => { e.preventDefault(); accept(m); }}>
                <Table2 /> <b>{m.name}</b> <em>{m.schema}</em>
              </button>
            ))}
          </div>
        )}
        <div className="ask">
          <textarea
            ref={input}
            rows={1}
            value={text}
            disabled={!ready || thinking}
            placeholder={ready ? "Ask, or @table…" : "Ask about this database…"}
            aria-label="Ask about this database"
            onChange={(e) => {
              setText(e.target.value);
              // Grow to the text, up to a point — long questions are a thing.
              e.target.style.height = "auto";
              e.target.style.height = `${Math.min(120, e.target.scrollHeight)}px`;
              syncMenu(e.target.value, e.target.selectionStart ?? e.target.value.length);
            }}
            onKeyDown={onKeyDown}
          />
          {thinking ? (
            <button className="send stop" onClick={() => { cancelled.current = true; pending?.resolve(false); }} aria-label="Stop" title="Stop after the current step">
              <Square />
            </button>
          ) : (
            <button className="send" disabled={!ready || !text.trim()} onClick={() => void send()} aria-label="Send">
              <ArrowUp />
            </button>
          )}
        </div>
        <div className="foot">
          <small>{hint}</small>
          <div className="modes" role="group" aria-label="How the steps run">
            {(["auto", "manual"] as const).map((m) => (
              <button key={m} className={mode === m ? "on" : ""} aria-pressed={mode === m} onClick={() => setMode(m)} title={m === "auto" ? "Read-only steps run as they come" : "Every step waits for you"}>
                {m}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** SQL the model wrote: copy it, open it in the editor, or run it — and once
 *  it has run, a chip that jumps to the tab holding the rows. */
function SqlCard({ sql, tabId, onRun, onOpen, onChart, onFocusTab, verification }: { sql: string; tabId: string | null; onRun: () => void; onOpen: () => void; onChart: () => void; onFocusTab: (tabId: string) => void; verification?: { ok: boolean; note: string } | null }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(sql);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  return (
    <div className="sqlcard">
      <div className="head">
        <span>SQL</span>
        <button className="lnk" onClick={copy}>
          <Copy /> {copied ? "Copied" : "Copy"}
        </button>
        <button className="lnk" onClick={onOpen} title="Open in a query tab without running it">
          <FileCode /> Editor
        </button>
        <button className="lnk" onClick={onChart} title="Chart this in a full-size tab">
          <ChartColumn /> Chart
        </button>
        <button className="lnk run" onClick={onRun}>
          <Play /> Run
        </button>
      </div>
      <pre className="selectable">{sql}</pre>
      {verification && (
        <div className={`verdict ${verification.ok ? "ok" : "bad"}`} title="The harness ran this small before showing it. This catches errors and empty results, not wrongness.">
          {verification.ok ? <Check /> : <X />} checked: {verification.note}
        </div>
      )}
      {tabId && <RunChip tabId={tabId} onClick={() => onFocusTab(tabId)} />}
    </div>
  );
}

/** Live summary of a run that happened in a query tab. */
function RunChip({ tabId, onClick }: { tabId: string; onClick: () => void }) {
  const run = useData((s) => s.queries[tabId]);
  if (!run) return null;
  if (run.running) return <div className="runchip">Running…</div>;
  if (run.error)
    return (
      <button className="runchip bad" onClick={onClick}>
        {run.error.message}
      </button>
    );
  const active = run.results[run.active];
  if (!active) return null;
  const rows = active.rowCount ?? 0;
  return (
    <button className="runchip ok" onClick={onClick} title="Open the results tab">
      {active.kind === "select" ? `${formatCount(rows)} rows` : `${formatCount(active.rowsAffected ?? 0)} affected`} · {formatDuration(run.totalMs)} — open
    </button>
  );
}
