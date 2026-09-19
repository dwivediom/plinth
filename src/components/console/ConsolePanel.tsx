import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { Segmented } from "../../components/common/Overlays";
import { formatDuration, timeOfDay } from "../../lib/format";
import { useConsole } from "../../state/console";
import { contextMenu, toast } from "../../state/overlays";
import { useUi } from "../../state/ui";
import { useWorkspaces } from "../../state/workspaces";

export function ConsolePanel({ workspaceId }: { workspaceId: string }) {
  const w = useWorkspaces((s) => s.byId[workspaceId]);
  const openQuery = useWorkspaces((s) => s.openQuery);
  const entries = useConsole((s) => s.entries);
  const loadError = useConsole((s) => s.loadError);
  const filter = useUi((s) => s.consoleFilter);
  const setFilter = useUi((s) => s.setConsoleFilter);
  const height = useUi((s) => s.consoleHeight);
  const setPref = useUi((s) => s.setPref);
  const toggle = useUi((s) => s.toggleConsole);
  const listRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const list = entries.filter((e) => (!w || e.connectionId === w.info.connectionId) && (filter === "all" || e.source === filter));
  const totalMs = list.reduce((a, e) => a + e.durationMs, 0);

  useEffect(() => {
    if (stick.current && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [list.length]);

  const onResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    const move = (ev: MouseEvent) => setPref("consoleHeight", Math.min(480, Math.max(80, startH - (ev.clientY - startY))));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    <div className="console" style={{ height }} role="log" aria-label="Console">
      <div className="resizer" onMouseDown={onResize} role="separator" aria-orientation="horizontal" />
      <div className="h">
        <b>Console</b>
        <Segmented small value={filter} onChange={setFilter} ariaLabel="Console filter" options={[{ value: "all", label: "All" }, { value: "app", label: "App" }, { value: "user", label: "User" }, { value: "ai", label: "AI" }]} />
        <span className="src">
          {list.length} statement{list.length === 1 ? "" : "s"} · {formatDuration(totalMs)}
        </span>
        <button className="icon-btn small" onClick={toggle} aria-label="Close console">
          <X />
        </button>
      </div>
      <div
        ref={listRef}
        className="lines"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
        }}
      >
        {!list.length && <div className="none secondary" style={{ padding: 12, textAlign: "center" }}>{loadError ? `Console unavailable: ${loadError}` : "Nothing logged yet."}</div>}
        {list.map((e) => (
          <button
            key={e.id}
            className="ln"
            onClick={() => openQuery(workspaceId, e.sql)}
            onContextMenu={(ev) =>
              contextMenu(ev, [
                { label: "Open in Query Tab", onSelect: () => openQuery(workspaceId, e.sql) },
                { label: "Copy SQL", onSelect: () => void navigator.clipboard.writeText(e.sql).then(() => toast("Copied SQL")) },
                { separator: true },
                { label: "Clear Console", onSelect: () => useConsole.getState().clear() },
              ])
            }
            title={e.error ? `${e.sql}\n\n${e.error}` : e.sql}
          >
            <span className="t">{timeOfDay(e.at)}</span>
            <span className={`src${e.source === "ai" ? " ai" : ""}`}>{e.source === "ai" ? "AI" : e.source === "app" ? "app" : "you"}</span>
            <span className={`sql${e.error ? " err" : ""}`}>{e.sql}</span>
            <span className="ms">
              {e.rows != null ? `${e.rows} rows · ` : ""}
              {formatDuration(e.durationMs)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
