import { useEffect, useMemo, useState } from "react";
import { Link2, Search, SlidersHorizontal } from "lucide-react";
import { Segmented } from "../../components/common/Overlays";
import type { Cell, ColumnDesc } from "../../ipc/types";
import { isNumericType } from "../../ipc/types";
import { cellEditText, cellText, cellsEqual, parseCellInput, timeOfDay } from "../../lib/format";
import { parseEngine, useAi } from "../../state/ai";
import { useConsole } from "../../state/console";
import { useData } from "../../state/data";
import { useUi } from "../../state/ui";
import { useWorkspaces } from "../../state/workspaces";
import { AiChat } from "./AiChat";
import { AiSetup } from "./AiSetup";
import { JsonSide } from "../json/JsonTabView";

export function Inspector({ workspaceId }: { workspaceId: string }) {
  const pane = useUi((s) => s.inspectorPane);
  const setPane = useUi((s) => s.setInspectorPane);
  return (
    <aside className="insp" aria-label="Inspector">
      <div className="tabs">
        <Segmented small value={pane} onChange={setPane} ariaLabel="Inspector pane" options={[{ value: "details", label: "Details" }, { value: "ai", label: "AI" }]} />
      </div>
      {pane === "details" ? <Details workspaceId={workspaceId} /> : <AiPane workspaceId={workspaceId} />}
    </aside>
  );
}

function Details({ workspaceId }: { workspaceId: string }) {
  const activeTabId = useWorkspaces((s) => s.byId[workspaceId]?.activeTabId ?? null);
  const openJson = useWorkspaces((s) => s.openJson);
  const setOverlay = useUi((s) => s.setOverlay);
  /** The same document, moved from the side into a tab of its own. */
  const openJsonTab = (c: ColumnDesc, v: Cell) =>
    openJson(workspaceId, typeof v === "string" ? v : JSON.stringify(v, null, 2), { origin: c.name, sqlColumn: c.name });
  /** Bigger, but still over the row rather than away from it. */
  const enlargeJson = (c: ColumnDesc, v: Cell) =>
    setOverlay({ kind: "json-zoom", text: typeof v === "string" ? v : JSON.stringify(v), title: c.name, sqlColumn: c.name });
  const sel = useData((s) => (activeTabId ? s.selections[activeTabId] : null));
  const [q, setQ] = useState("");
  const fields = useMemo(() => {
    if (!sel) return [];
    return sel.columns.map((c, i) => ({ c, i })).filter(({ c }) => !q || c.name.toLowerCase().includes(q.toLowerCase()));
  }, [sel, q]);

  return (
    <>
      <div className="field">
        <span className="glyph">
          <Search />
        </span>
        <input value={q} placeholder="Search fields" aria-label="Search fields" onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setQ("")} />
      </div>
      <div className="body">
        {!sel && <div className="none secondary" style={{ padding: 20, textAlign: "center", font: "var(--t-callout)" }}>Select a row to see its fields.</div>}
        {sel && !fields.length && <div className="none secondary" style={{ padding: 20, textAlign: "center", font: "var(--t-callout)" }}>No fields match “{q}”.</div>}
        {sel &&
          fields.map(({ c, i }) => {
            const fk = sel.foreignKeys.find((f) => f.columns.length === 1 && f.columns[0] === c.name);
            return <Field key={c.name} onOpenJsonTab={() => openJsonTab(c, sel.values[i])} onEnlargeJson={() => enlargeJson(c, sel.values[i])} column={c} value={sel.values[i]} dirty={!cellsEqual(sel.values[i], sel.original[i])} editable={sel.editable} onEdit={sel.onEdit ? (v) => sel.onEdit!(i, v) : undefined} fk={fk ? `${fk.refTable.name}.${fk.refColumns[0]}` : null} onFollowFk={fk && sel.onFollowFk ? () => sel.onFollowFk!(i) : undefined} />;
          })}
      </div>
    </>
  );
}

function Field({ column, value, dirty, editable, onEdit, fk, onFollowFk, onOpenJsonTab, onEnlargeJson }: { column: ColumnDesc; value: Cell; dirty: boolean; editable: boolean; onEdit?: (v: Cell) => void; fk: string | null; onFollowFk?: () => void; onOpenJsonTab?: () => void; onEnlargeJson?: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  // One viewer for every document, whatever its size. Two renderers for the
  // same thing is how you end up with a two-key object laid out differently
  // from a two-thousand-key one.
  const isJson = column.logical === "json" && value != null && typeof value === "object";
  const isLong = typeof value === "string" && value.length > 60;

  const begin = () => {
    if (!editable || !onEdit) return;
    setText(cellEditText(value, column.logical));
    setError(null);
    setEditing(true);
  };
  const commit = () => {
    if (!onEdit) return;
    const r = parseCellInput(text, column);
    if (!r.ok) return setError(r.error);
    onEdit(r.value);
    setEditing(false);
  };

  return (
    <div className="f">
      <div className="n">
        <span className="truncate">
          {column.name}
          {fk && (
            <button className="fk" title={`References ${fk}`} onClick={onFollowFk} style={{ marginLeft: 4 }}>
              <Link2 />
            </button>
          )}
        </span>
        <em title={column.dataType}>{column.dataType}</em>
      </div>
      {editing ? (
        column.wire === "json" || isLong ? (
          <div className={`v multi${dirty ? " d" : ""}`} style={error ? { boxShadow: "inset 0 0 0 1px var(--red)" } : undefined}>
            <textarea
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Escape") setEditing(false);
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) commit();
              }}
            />
          </div>
        ) : column.wire === "bool" ? (
          <div className="v">
            <input type="checkbox" autoFocus checked={value === true} onChange={(e) => { onEdit?.(e.target.checked); setEditing(false); }} onBlur={() => setEditing(false)} />
          </div>
        ) : (
          <div className={`v${dirty ? " d" : ""}`} style={error ? { boxShadow: "inset 0 0 0 1px var(--red)" } : undefined} title={error ?? undefined}>
            <input
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit();
                if (e.key === "Escape") setEditing(false);
                if (e.key === "Backspace" && (e.metaKey || e.ctrlKey) && column.nullable !== false) {
                  onEdit?.(null);
                  setEditing(false);
                }
              }}
              style={isNumericType(column.logical) ? { textAlign: "right" } : undefined}
            />
          </div>
        )
      ) : isJson ? (
        // The inspector is the side view: the grid stays where it is and the
        // document opens beside it. Small ones stay in the little tree;
        // anything with real structure gets the viewer, with its search.
        <div className={`v multi${dirty ? " d" : ""}`} onDoubleClick={begin} title={editable ? "Double-click to edit" : undefined}>
          <div className="jside">
            <JsonSide
              text={typeof value === "string" ? value : JSON.stringify(value)}
              title={column.name}
              sqlColumn={column.name}
              onOpenTab={onOpenJsonTab}
              onEnlarge={onEnlargeJson}
            />
          </div>
        </div>
      ) : (
        <div className={`v${dirty ? " d" : ""}${editable ? "" : " ro"}${isLong ? " multi" : ""}`} onDoubleClick={begin} title={editable ? "Double-click to edit" : cellText(value, column.logical)}>
          {value == null ? <span className="null">NULL</span> : <span className={isNumericType(column.logical) ? "num" : ""} style={{ width: "100%" }}>{cellText(value, column.logical)}</span>}
        </div>
      )}
    </div>
  );
}

function AiPane({ workspaceId }: { workspaceId: string }) {
  const [view, setView] = useState<"chat" | "activity">("chat");
  const [setupOpen, setSetupOpen] = useState<boolean | null>(null);
  const status = useAi((s) => s.status);
  const engine = useAi((s) => s.engine);
  const probe = useAi((s) => s.probe);

  // The pane itself probes: the setup panel is collapsed most of the time, and
  // until we know what's installed the chat can't tell whether it's ready.
  useEffect(() => {
    if (!status) void probe();
  }, [status, probe]);

  const sel = parseEngine(engine);
  const model = sel?.kind === "ollama" ? status?.models.find((m) => m.name === sel.model) ?? null : null;
  const client = sel?.kind === "mcp" ? status?.mcp.clients.find((c) => c.id === sel.client) ?? null : null;
  const ready = sel?.kind === "ollama" ? model?.installed === true && status?.ollama.running === true : client?.registered === true;
  const engineName = model?.label ?? client?.name ?? "No model";
  // Setup opens itself while nothing can answer, and gets out of the way once
  // something can — until the person opens it deliberately.
  const showSetup = setupOpen ?? (status != null && !ready);

  return (
    <>
      <div className="ai-top">
        <Segmented small value={view} onChange={setView} ariaLabel="AI view" options={[{ value: "chat", label: "Chat" }, { value: "activity", label: "Activity" }]} />
        <button className={`lnk${showSetup ? " on" : ""}`} onClick={() => setSetupOpen(!showSetup)} title="Local model and MCP setup">
          <SlidersHorizontal />
          <span className="truncate">{engineName}</span>
          <span className={`dot ${ready ? "g" : "o"}`} aria-hidden />
        </button>
      </div>
      {showSetup && (
        <div className="ai-setup-drop">
          <AiSetup />
        </div>
      )}
      {view === "chat" ? <AiChat workspaceId={workspaceId} /> : <AiActivity workspaceId={workspaceId} />}
    </>
  );
}

function AiActivity({ workspaceId }: { workspaceId: string }) {
  const w = useWorkspaces((s) => s.byId[workspaceId]);
  const entries = useConsole((s) => s.entries);
  const [q, setQ] = useState("");
  const ai = entries.filter((e) => e.source === "ai" && (!w || e.connectionId === w.info.connectionId) && (!q || e.sql.toLowerCase().includes(q.toLowerCase()))).reverse();
  return (
    <>
      <div className="field">
        <span className="glyph">
          <Search />
        </span>
        <input value={q} placeholder="Filter activity" aria-label="Filter AI activity" onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="body">
        {!ai.length && <div className="none secondary" style={{ padding: 20, textAlign: "center", font: "var(--t-callout)" }}>Nothing has run through the model yet. SQL you run from a chat answer, and every MCP call, is logged here.</div>}
        {ai.map((e) => (
          <div key={e.id} className="airow">
            <div className="h">
              <span>{timeOfDay(e.at)}</span>
              <b>{e.error ? "query · error" : "query"}</b>
              <span style={{ marginLeft: "auto" }}>{e.durationMs} ms{e.rows != null ? ` · ${e.rows} rows` : ""}</span>
            </div>
            <div className="s selectable" title={e.sql}>
              {e.sql}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
