import { useCallback, useRef } from "react";
import { ArrowLeftRight, ChevronDown, Database, GitCompare, Info, Plus, Search } from "lucide-react";
import { Segmented } from "../../components/common/Overlays";
import { isTauri } from "../../ipc/client";
import { chordLabel, isMac } from "../../lib/keys";
import { contextMenu } from "../../state/overlays";
import { useUi, type SidebarPane } from "../../state/ui";
import { useWorkspaces } from "../../state/workspaces";
import { ItemsPane } from "./ItemsPane";
import { QueriesPane } from "./QueriesPane";
import { HistoryPane } from "./HistoryPane";

export function Sidebar({ workspaceId }: { workspaceId: string }) {
  const pane = useUi((s) => s.sidebarPane);
  const setPane = useUi((s) => s.setSidebarPane);
  const setOverlay = useUi((s) => s.setOverlay);
  const setPref = useUi((s) => s.setPref);
  const openQuery = useWorkspaces((s) => s.openQuery);
  const openDiff = useWorkspaces((s) => s.openDiff);
  const dragging = useRef(false);

  const onResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragging.current = true;
      const startX = e.clientX;
      const startW = useUi.getState().sidebarWidth;
      const move = (ev: MouseEvent) => {
        const w = Math.min(320, Math.max(180, startW + ev.clientX - startX));
        setPref("sidebarWidth", w);
      };
      const up = () => {
        dragging.current = false;
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    [setPref],
  );

  return (
    <aside className="side" aria-label="Sidebar">
      <div className={`top${isMac && isTauri ? " mac" : ""}`} data-tauri-drag-region>
        <div className="sw" role="toolbar" aria-label="Switchers">
          <button className="icon-btn small" title={`Open Anything ${chordLabel("Mod+P")}`} onClick={() => setOverlay({ kind: "palette" })}>
            <Search />
          </button>
          <button className="icon-btn small" title={`Databases ${chordLabel("Mod+K")}`} onClick={() => setOverlay({ kind: "db-switcher" })}>
            <Database />
          </button>
          <button className="icon-btn small" title={`Connections ${chordLabel("Mod+Shift+K")}`} onClick={() => setOverlay({ kind: "conn-switcher" })}>
            <ArrowLeftRight />
          </button>
          <button className="icon-btn small" title={`Guide & Features ${chordLabel("Mod+Shift+/")}`} onClick={() => setOverlay({ kind: "guide" })}>
            <Info />
          </button>
          <button className="icon-btn small" title={`Compare Schema ${chordLabel("Mod+Shift+D")}`} onClick={() => openDiff(workspaceId)}>
            <GitCompare />
          </button>
        </div>
      </div>
      <div className="head">
        <Segmented<SidebarPane> small fill value={pane} onChange={setPane} ariaLabel="Sidebar pane" options={[{ value: "items", label: "Items" }, { value: "queries", label: "Queries" }, { value: "history", label: "History" }]} />
      </div>
      {pane === "items" && <ItemsPane workspaceId={workspaceId} />}
      {pane === "queries" && <QueriesPane workspaceId={workspaceId} />}
      {pane === "history" && <HistoryPane workspaceId={workspaceId} />}
      <div className="foot">
        <button
          className="icon-btn small"
          title="New…"
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            contextMenu({ preventDefault() {}, stopPropagation() {}, clientX: r.left, clientY: r.top - 34 }, [
              { label: "New Query", shortcut: chordLabel("Mod+T"), onSelect: () => openQuery(workspaceId) },
              { label: "New Table…", disabled: true },
              { label: "New View…", disabled: true },
            ]);
          }}
        >
          <Plus />
          <ChevronDown style={{ width: 10, height: 10 }} />
        </button>
      </div>
      <div className="resizer" onMouseDown={onResizeStart} role="separator" aria-orientation="vertical" />
    </aside>
  );
}
