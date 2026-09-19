import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChartColumn, ChevronDown, CircleX, Gauge, Lock, Play, Wand, Waypoints } from "lucide-react";
import { errorMessage, invoke } from "../../ipc/client";
import type { QueryResult } from "../../ipc/types";
import { useBus } from "../../lib/bus";
import { formatCount, formatDuration } from "../../lib/format";
import { chordLabel } from "../../lib/keys";
import { policyWayOut } from "../../lib/policyWayOut";
import { explainSql } from "../../lib/explain";
import { closeCompletion } from "@codemirror/autocomplete";
import { guardWrite } from "../../lib/writeGate";
import { runOptimize } from "../../lib/optimizeRun";
import { parseEngine, useAi } from "../../state/ai";
import { beautify, lineColToOffset, statementAt, tokenLengthAt } from "../../lib/sql";
import { useData } from "../../state/data";
import { useGraph } from "../../state/graph";
import { contextMenu, prompt, toast } from "../../state/overlays";
import { useSaved } from "../../state/saved";
import type { PlanTab, QueryTab } from "../../state/types";
import { useUi } from "../../state/ui";
import { useWorkspaces } from "../../state/workspaces";
import { SqlEditor, type SqlEditorHandle } from "./SqlEditor";
import { ResultsPane } from "./ResultsPane";

/** One statement in, its single JSON cell out — the EXPLAIN shape. */
async function oneJsonCell(workspaceId: string, sql: string): Promise<string | null> {
  const results = await invoke("query_run", { workspaceId, sql, limit: 1 });
  const first = results[0];
  if (first?.error || !first?.cursorId) return null;
  const window = await invoke("cursor_fetch", { cursorId: first.cursorId, offset: 0, len: 1 });
  void invoke("cursor_close", { cursorId: first.cursorId }).catch(() => {});
  const cell = window.rows[0]?.[0];
  return typeof cell === "string" ? cell : cell == null ? null : JSON.stringify(cell);
}

/** `select … from orders` → `orders`, for the tab title. */
function tabTitleOf(sql: string): string {
  const m = sql.replace(/\s+/g, " ").match(/\b(?:from|into|update|table)\s+([\w.]+)/i);
  const name = m?.[1] ?? "query";
  return name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name;
}

export function QueryView({ workspaceId, tabId }: { workspaceId: string; tabId: string }) {
  const w = useWorkspaces((s) => s.byId[workspaceId]);
  const tab = useWorkspaces((s) => s.byId[workspaceId]?.tabs.find((t) => t.id === tabId)) as QueryTab | undefined;
  const setQueryText = useWorkspaces((s) => s.setQueryText);
  const updateTab = useWorkspaces((s) => s.updateTab);
  const markSaved = useWorkspaces((s) => s.markSaved);
  const setRunning = useWorkspaces((s) => s.setRunning);
  const openChart = useWorkspaces((s) => s.openChart);
  const openPlan = useWorkspaces((s) => s.openPlan);
  const graph = useGraph((s) => s.byWorkspace[workspaceId] ?? null);
  const loadGraph = useGraph((s) => s.load);
  const saveQuery = useSaved((s) => s.save);
  const run = useData((s) => s.queries[tabId]);
  const setQuery = useData((s) => s.setQuery);
  const ensureCursor = useData((s) => s.ensureCursor);
  const editorSplit = useUi((s) => s.editorSplit);
  const setPref = useUi((s) => s.setPref);
  const editor = useRef<SqlEditorHandle>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ line: 1, column: 1 });
  const runSeq = useRef(0);

  const limit = tab?.limit ?? null;

  const onChange = useCallback((text: string, cursor: number) => setQueryText(workspaceId, tabId, text, cursor), [setQueryText, workspaceId, tabId]);
  const onCursor = useCallback((line: number, column: number, offset: number) => {
    setPos((p) => (p.line === line && p.column === column ? p : { line, column }));
    cursorRef.current = offset;
  }, []);
  const cursorRef = useRef(tab?.cursor ?? 0);

  // persist the cursor lazily
  useEffect(() => {
    const t = setInterval(() => {
      if (tab && cursorRef.current !== tab.cursor) updateTab<QueryTab>(workspaceId, tabId, { cursor: cursorRef.current });
    }, 2000);
    return () => clearInterval(t);
  }, [tab, updateTab, workspaceId, tabId]);

  const execute = useCallback(
    async (mode: "current" | "all" | "selection") => {
      const ed = editor.current;
      if (!ed || !w) return;
      const text = ed.getText();
      let sqlText = text;
      let base = 0;
      const sel = ed.getSelection();
      if (mode === "selection" || (mode === "current" && sel.text.trim())) {
        sqlText = sel.text;
        base = sel.from;
      } else if (mode === "current") {
        const st = statementAt(text, ed.getCursor());
        if (!st) return;
        sqlText = st.text;
        base = st.from;
      }
      if (!sqlText.trim()) return;
      // Running dismisses the completion popup — it is a tooltip about what
      // you were typing, and you have stopped typing.
      if (ed.view) closeCompletion(ed.view);
      // Nothing destructive is sent until someone has seen it. The engine's
      // policy still decides what is *allowed*; this decides what was meant.
      const gate = await guardWrite(workspaceId, sqlText);
      if (!gate.ok) return;
      const seq = ++runSeq.current;
      ed.clearError();
      // drop previous cursors
      const prev = useData.getState().queries[tabId];
      prev?.results.forEach((r) => r.cursorId && invoke("cursor_close", { cursorId: r.cursorId }).catch(() => {}));
      setQuery(tabId, { running: true, error: null, results: [], active: 0, ranAt: Date.now(), limitApplied: limit });
      setRunning(workspaceId, tabId, true);
      const t0 = performance.now();
      try {
        const results: QueryResult[] = await invoke("query_run", { workspaceId, sql: sqlText, limit, source: tab?.source });
        if (seq !== runSeq.current) return;
        const failed = results.find((r) => r.error);
        results.forEach((r) => r.cursorId && ensureCursor(r.cursorId));
        setQuery(tabId, { running: false, results, active: failed ? results.indexOf(failed) : 0, error: failed?.error ?? null, errorBase: base, totalMs: Math.round(performance.now() - t0) });
        if (failed?.error && failed.error.line != null) {
          const off = base + lineColToOffset(sqlText, failed.error.line, failed.error.column ?? 1);
          ed.setError(off, off + tokenLengthAt(text, off));
        }
      } catch (e) {
        if (seq !== runSeq.current) return;
        setQuery(tabId, { running: false, results: [], error: { message: errorMessage(e), line: null, column: null, code: null, blockedByPolicy: false }, totalMs: Math.round(performance.now() - t0) });
      } finally {
        if (seq === runSeq.current) setRunning(workspaceId, tabId, false);
      }
    },
    [w, workspaceId, tabId, limit, setQuery, ensureCursor, setRunning, tab?.source],
  );

  /**
   * Read the plan without leaving the app. `ANALYZE` executes the statement,
   * so it is gated on the policy engine saying the statement is read-only —
   * you cannot accidentally EXPLAIN ANALYZE a DELETE.
   */
  const explain = useCallback(
    async (analyze: boolean) => {
      const ed = editor.current;
      if (!ed) return;
      const selection = ed.getSelection();
      const text = selection.text.trim() || statementAt(ed.getText(), ed.getCursor())?.text || ed.getText();
      const sqlText = text.trim();
      if (!sqlText) return;
      if (w?.info.driver !== "postgres") return toast("Visual plans are Postgres-only for now.", "error");

      try {
        if (analyze) {
          const check = await invoke("sql_check", { workspaceId, sql: sqlText });
          if (check.statements.length !== 1) return toast("Explain one statement at a time.", "error");
          if (!check.readOnly) return toast("EXPLAIN ANALYZE runs the statement — this one writes, so it is refused.", "error");
        }
        const results = await invoke("query_run", { workspaceId, sql: explainSql(sqlText, analyze), limit: 1 });
        const first = results[0];
        if (first?.error) return toast(first.error.message, "error");
        if (!first?.cursorId) return toast("The server returned no plan.", "error");
        const window = await invoke("cursor_fetch", { cursorId: first.cursorId, offset: 0, len: 1 });
        void invoke("cursor_close", { cursorId: first.cursorId }).catch(() => {});
        const cell = window.rows[0]?.[0];
        const json = typeof cell === "string" ? cell : JSON.stringify(cell);
        if (!json) return toast("The server returned no plan.", "error");
        openPlan(workspaceId, sqlText, json, analyze);
      } catch (e) {
        toast(errorMessage(e), "error");
      }
    },
    [w?.info.driver, workspaceId, openPlan],
  );

  /**
   * Explain, then work out what would make it faster — and measure each
   * answer against the planner rather than asserting it.
   */
  const optimize = useCallback(async () => {
    const ed = editor.current;
    if (!ed || !w) return;
    const sqlText = (ed.getSelection().text.trim() || statementAt(ed.getText(), ed.getCursor())?.text || ed.getText()).trim();
    if (!sqlText) return;
    if (w.info.driver !== "postgres") return toast("Optimize is Postgres-only for now.", "error");
    const check = await invoke("sql_check", { workspaceId, sql: sqlText });
    if (check.statements.length !== 1) return toast("Optimize one statement at a time.", "error");
    if (!check.readOnly) return toast("Optimize reads the plan of a statement — this one writes, so it is refused.", "error");

    const captured = await oneJsonCell(workspaceId, explainSql(sqlText, false));
    if (!captured) return toast("The server returned no plan.", "error");
    const tabId2 = openPlan(workspaceId, sqlText, captured, false);
    updateTab<PlanTab>(workspaceId, tabId2, { title: `Optimize · ${tabTitleOf(sqlText)}`, optimizing: "Reading the plan" });
    try {
      const report = await runOptimize({
        workspaceId,
        sql: sqlText,
        planJson: captured,
        schema: w.schema ?? null,
        // Only a local model can be asked; an MCP client is not a rewriter.
        model: parseEngine(useAi.getState().engine)?.kind === "ollama" ? (parseEngine(useAi.getState().engine) as { model: string }).model : null,
        onProgress: (what) => updateTab<PlanTab>(workspaceId, tabId2, { optimizing: what }),
      });
      updateTab<PlanTab>(workspaceId, tabId2, { optimize: report, optimizing: null });
    } catch (e) {
      updateTab<PlanTab>(workspaceId, tabId2, { optimizing: null });
      toast(errorMessage(e), "error");
    }
  }, [w, workspaceId, openPlan, updateTab]);

  /**
   * The way out of a policy refusal: run this one statement as if the
   * connection were `full`.
   *
   * It still goes through the write gate, so a DDL statement is typed out
   * before it runs — the elevation removes the policy's objection, not the
   * one that asks whether you meant it. The engine refuses to elevate a
   * read-only connection or one with the padlock on, and remembers nothing.
   */
  const runElevated = useCallback(async () => {
    const ed = editor.current;
    if (!ed) return;
    const sqlText = (ed.getSelection().text.trim() || statementAt(ed.getText(), ed.getCursor())?.text || ed.getText()).trim();
    if (!sqlText) return;
    const gate = await guardWrite(workspaceId, sqlText, { elevated: true });
    if (!gate.ok) return;
    setQuery(tabId, { running: true, error: null, results: [], active: 0, ranAt: Date.now(), limitApplied: limit });
    const t0 = performance.now();
    try {
      const results = await invoke("query_run_elevated", { workspaceId, sql: sqlText, limit });
      const failed = results.find((r) => r.error);
      results.forEach((r) => r.cursorId && ensureCursor(r.cursorId));
      setQuery(tabId, { running: false, results, active: failed ? results.indexOf(failed) : 0, error: failed?.error ?? null, totalMs: Math.round(performance.now() - t0) });
      if (!failed) toast("Ran once with the policy lifted. The connection's policy is unchanged.");
    } catch (e) {
      setQuery(tabId, { running: false, results: [], error: { message: errorMessage(e), line: null, column: null, code: null, blockedByPolicy: false }, totalMs: Math.round(performance.now() - t0) });
    }
  }, [workspaceId, tabId, limit, setQuery, ensureCursor]);

  const cancel = useCallback(async () => {
    if (!run?.running) return;
    runSeq.current++;
    setQuery(tabId, { running: false, error: { message: "Cancelled", line: null, column: null, code: null, blockedByPolicy: false } });
    setRunning(workspaceId, tabId, false);
    try {
      await invoke("query_cancel", { workspaceId });
    } catch {
      /* ignore */
    }
  }, [run?.running, setQuery, tabId, setRunning, workspaceId]);

  const doBeautify = useCallback(() => {
    const ed = editor.current;
    if (!ed) return;
    const text = ed.getText();
    if (!text.trim()) return;
    ed.setText(beautify(text));
  }, []);

  const save = useCallback(async () => {
    const ed = editor.current;
    if (!tab || !ed || !w) return;
    const sqlText = ed.getText();
    let name = tab.kind === "saved" ? tab.title : null;
    if (!name) {
      name = await prompt("Save Query As", tab.customTitle ? tab.title : "", "Name");
      if (!name) return;
    }
    const existing = tab.savedId ? useSaved.getState().list.find((q) => q.id === tab.savedId) : undefined;
    try {
      const saved = await saveQuery({ id: tab.savedId ?? "", connectionId: existing?.connectionId ?? w.info.connectionId, name, folder: existing?.folder ?? null, sql: sqlText, updatedAt: new Date().toISOString() });
      markSaved(workspaceId, tabId, saved);
      toast(`Saved “${saved.name}”`);
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  }, [tab, w, saveQuery, markSaved, workspaceId, tabId]);

  // A tab the AI pane opened runs itself once, then behaves like any other.
  // The ref latch — not just the flag — is what makes "once" true: clearing
  // the flag is a state update, so a second effect pass (StrictMode, or two
  // renders racing) would otherwise run the statement again. For an INSERT
  // that is not a cosmetic bug.
  const autoRan = useRef(false);
  useEffect(() => {
    if (!tab?.autoRun || autoRan.current) return;
    autoRan.current = true;
    updateTab<QueryTab>(workspaceId, tabId, { autoRun: false });
    void execute("all");
  }, [tab?.autoRun, updateTab, workspaceId, tabId, execute]);

  // JOIN completion needs the FK graph; it is cached per workspace.
  useEffect(() => {
    void loadGraph(workspaceId);
  }, [loadGraph, workspaceId]);

  useBus("run", useCallback(({ mode }) => void execute(mode), [execute]));
  useBus("cancel", useCallback(() => void cancel(), [cancel]));
  useBus("beautify", doBeautify);
  useBus("save", useCallback(() => void save(), [save]));
  useBus("reload", useCallback(() => { if (run?.results.length) void execute("all"); }, [run?.results.length, execute]));
  useBus("focus-editor", useCallback(() => editor.current?.focus(), []));

  useEffect(() => {
    editor.current?.focus();
  }, []);

  const onDivider = (e: React.MouseEvent) => {
    e.preventDefault();
    const root = rootRef.current;
    if (!root) return;
    const rect = root.getBoundingClientRect();
    const move = (ev: MouseEvent) => setPref("editorSplit", Math.min(0.85, Math.max(0.15, (ev.clientY - rect.top) / rect.height)));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  if (!tab || !w) return null;
  const active = run?.results[run.active];
  const selText = editor.current?.getSelection().text.trim();
  const runLabel = selText ? "Run Selected" : "Run Current";

  return (
    <div className="query" ref={rootRef}>
      <div className="editor-pane" style={{ flexBasis: `${editorSplit * 100}%`, height: `${editorSplit * 100}%` }}>
        <SqlEditor ref={editor} initialText={tab.text} initialCursor={tab.cursor} driver={w.info.driver} schema={w.schema} graph={graph} onChange={onChange} onCursor={onCursor} />
        <div className="querybar">
          <span className="pos">
            line {pos.line}, column {pos.column}
          </span>
          <select
            className="native"
            aria-label="Row limit"
            value={limit == null ? "none" : [100, 1000, 10000].includes(limit) ? String(limit) : "custom"}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "custom") {
                void prompt("Row limit", String(limit ?? 500), "Rows").then((s) => {
                  const n = Number(s);
                  if (s && Number.isFinite(n) && n > 0) updateTab<QueryTab>(workspaceId, tabId, { limit: Math.floor(n) });
                });
              } else updateTab<QueryTab>(workspaceId, tabId, { limit: v === "none" ? null : Number(v) });
            }}
          >
            <option value="none">No limit</option>
            <option value="100">Limit 100</option>
            <option value="1000">Limit 1000</option>
            <option value="10000">Limit 10 000</option>
            <option value="custom">{limit != null && ![100, 1000, 10000].includes(limit) ? `Limit ${formatCount(limit)}` : "Custom…"}</option>
          </select>
          <div className="r">
            {tab.kind === "saved" ? <span className="tertiary">{tab.text.trim() !== tab.savedText.trim() ? "Unsaved edits" : "Saved"}</span> : null}
            <button className="btn" onClick={doBeautify} title={`Beautify ${chordLabel("Mod+I")}`}>
              <Wand style={{ width: 12, height: 12 }} /> Beautify
            </button>
            <button
              className="btn"
              title="Read the query plan — ⌥ for EXPLAIN ANALYZE, which runs it"
              onClick={(e) => {
                if (e.altKey) void explain(true);
                else
                  contextMenu(e, [
                    { label: "Explain", onSelect: () => void explain(false) },
                    { label: "Explain Analyze", shortcut: "⌥", onSelect: () => void explain(true) },
                  ]);
              }}
            >
              <Waypoints style={{ width: 12, height: 12 }} /> Explain
            </button>
            <button
              className="btn"
              title="Find what is slow and what would fix it — measured against the planner"
              onClick={() => void optimize()}
            >
              <Gauge style={{ width: 12, height: 12 }} /> Optimize
            </button>
            <button
              className="btn"
              disabled={!run?.results.length}
              title="Chart this result in its own tab"
              onClick={() => {
                const sqlText = editor.current?.getText().trim();
                if (sqlText) openChart(workspaceId, sqlText, { title: `Chart · ${tab?.title ?? "query"}` });
              }}
            >
              <ChartColumn style={{ width: 12, height: 12 }} /> Chart
            </button>
            {run?.running ? (
              <button className="btn" onClick={() => void cancel()} title={`Cancel ${chordLabel("Mod+.")}`}>
                <CircleX style={{ width: 12, height: 12 }} /> Cancel
              </button>
            ) : (
              <button
                className="btn default"
                onClick={(e) => {
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  if (e.clientX > r.right - 18) {
                    contextMenu({ preventDefault() {}, stopPropagation() {}, clientX: r.right - 180, clientY: r.bottom + 4 }, [
                      { label: "Run Current Statement", shortcut: chordLabel("Mod+Enter"), onSelect: () => void execute("current") },
                      { label: "Run Selection", disabled: !selText, onSelect: () => void execute("selection") },
                      { label: "Run All", shortcut: chordLabel("Mod+Shift+Enter"), onSelect: () => void execute("all") },
                    ]);
                  } else void execute("current");
                }}
                title={`${runLabel} ${chordLabel("Mod+Enter")} · Run All ${chordLabel("Mod+Shift+Enter")}`}
              >
                <Play style={{ width: 11, height: 11 }} /> {runLabel}
                <span className="caret">
                  <ChevronDown />
                </span>
              </button>
            )}
          </div>
        </div>
      </div>
      <div className="divider" onMouseDown={onDivider} role="separator" aria-orientation="horizontal" />
      <div className="results">
        {run?.error && (
          <div className="errrow" role="alert">
            <CircleX />
            <span className="msg">
              {run.error.message}
              {run.error.line != null ? ` — line ${run.error.line}${run.error.column != null ? `, column ${run.error.column}` : ""}` : ""}
              {run.error.code ? <code className="tertiary"> · {run.error.code}</code> : null}
            </span>
            {run.error.blockedByPolicy && (
              <>
                <span className="pol">
                  <Lock style={{ width: 11, height: 11 }} /> blocked by policy
                </span>
                <PolicyWayOut workspaceId={workspaceId} refusal={run.error.message} onElevate={() => void runElevated()} />
              </>
            )}
          </div>
        )}
        {run && (run.running || run.results.length > 0) && (
          <div className="timing">
            {run.running ? (
              <span className="running">
                <progress /> Running…
              </span>
            ) : active ? (
              <>
                {active.error ? "failed" : active.kind === "select" && active.rowCount != null ? `${formatCount(active.rowCount)} row${active.rowCount === 1 ? "" : "s"}` : active.rowsAffected != null ? `${formatCount(active.rowsAffected)} affected` : "done"}
                <span>·</span>
                {formatDuration(active.durationMs)}
                {run.limitApplied != null && active.kind === "select" && !active.error && (
                  <>
                    <span>·</span>
                    LIMIT {formatCount(run.limitApplied)} applied{active.truncated ? "" : " (not reached)"}
                  </>
                )}
                {run.results.length > 1 && (
                  <>
                    <span>·</span>
                    {run.results.length} statements in {formatDuration(run.totalMs)}
                  </>
                )}
              </>
            ) : null}
          </div>
        )}
        <ResultsPane workspaceId={workspaceId} tabId={tabId} />
      </div>
    </div>
  );
}

/** The way out of a refusal, as a button. The decision lives in
 *  `lib/policyWayOut.ts` so a notice and this row never disagree. */
function PolicyWayOut({ workspaceId, refusal, onElevate }: { workspaceId: string; refusal: string; onElevate: () => void }) {
  // Subscribed so the button changes the moment the padlock does.
  const safeMode = useWorkspaces((s) => s.byId[workspaceId]?.safeMode);
  const policy = useWorkspaces((s) => s.byId[workspaceId]?.info.policy);
  const way = useMemo(() => policyWayOut(workspaceId, refusal, onElevate), [workspaceId, refusal, onElevate, safeMode, policy]);
  if (!way) return null;
  return (
    <button className="btn mini" onClick={way.run}>
      {way.label}
    </button>
  );
}
