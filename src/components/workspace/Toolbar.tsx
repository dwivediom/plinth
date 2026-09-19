import { Ban, Keyboard, Lock, LockOpen, PanelBottom, PanelLeft, PanelRight, RotateCw, Search, ShieldCheck } from "lucide-react";
import { toggleSafeMode } from "../../app/actions";
import { Segmented } from "../../components/common/Overlays";
import { isTauri } from "../../ipc/client";
import { bus } from "../../lib/bus";
import { envColor } from "../../lib/format";
import { chordLabel, isMac } from "../../lib/keys";
import { isQueryTab, type TableTab } from "../../state/types";
import { useUi } from "../../state/ui";
import { useWorkspaces } from "../../state/workspaces";

export function Toolbar({ workspaceId }: { workspaceId: string }) {
  const w = useWorkspaces((s) => s.byId[workspaceId]);
  const tab = useWorkspaces((s) => s.byId[workspaceId]?.tabs.find((t) => t.id === s.byId[workspaceId]?.activeTabId));
  const updateTab = useWorkspaces((s) => s.updateTab);
  const openQuery = useWorkspaces((s) => s.openQuery);
  const openMap = useWorkspaces((s) => s.openMap);
  const activateTab = useWorkspaces((s) => s.activateTab);
  const sidebarVisible = useUi((s) => s.sidebarVisible);
  const toggleSidebar = useUi((s) => s.toggleSidebar);
  const inspectorVisible = useUi((s) => s.inspectorVisible);
  const toggleInspector = useUi((s) => s.toggleInspector);
  const consoleVisible = useUi((s) => s.consoleVisible);
  const toggleConsole = useUi((s) => s.toggleConsole);
  const setOverlay = useUi((s) => s.setOverlay);
  const setShowLauncher = useUi((s) => s.setShowLauncher);
  if (!w) return null;

  const running = Object.keys(w.runningTabs).length > 0;
  const env = envColor(w.info.environment);
  const view: "data" | "structure" | "query" | "map" = tab?.kind === "table" ? tab.view : tab?.kind === "map" ? "map" : "query";
  const tableTab = tab?.kind === "table" ? tab : null;

  const setView = (v: "data" | "structure" | "query" | "map") => {
    if (v === "map") {
      openMap(workspaceId);
      return;
    }
    if (v === "query") {
      // a table tab switches to (or opens) a query on that table
      const existing = w.tabs.find((t) => isQueryTab(t) && t.id === w.activeTabId);
      if (existing) return;
      const q = tableTab ? `select * from ${tableTab.table.schema ? `${tableTab.table.schema}.` : ""}${tableTab.table.name}\nlimit 100;` : "";
      const last = [...w.tabs].reverse().find(isQueryTab);
      if (!tableTab && last) activateTab(workspaceId, last.id);
      else openQuery(workspaceId, q);
      return;
    }
    if (tableTab) updateTab<TableTab>(workspaceId, tableTab.id, { view: v });
    else {
      const lastTable = [...w.tabs].reverse().find((t) => t.kind === "table");
      if (lastTable) {
        activateTab(workspaceId, lastTable.id);
        updateTab<TableTab>(workspaceId, lastTable.id, { view: v });
      }
    }
  };

  return (
    <div className={`toolbar${isMac && isTauri && !sidebarVisible ? " mac-no-sidebar" : ""}`} data-tauri-drag-region role="toolbar">
      <button className="icon-btn" title={`Toggle Sidebar ${chordLabel("Mod+Alt+S")}`} aria-pressed={sidebarVisible} onClick={toggleSidebar}>
        <PanelLeft />
      </button>
      <div className="crumb" data-tauri-drag-region>
        <span className={`env${env ? "" : " none"}`} style={{ background: env ?? undefined }} />
        <button onClick={() => setShowLauncher(true)} title="Connections">{w.info.connectionName}</button>
        <span className="sepc">:</span>
        <button onClick={() => setOverlay({ kind: "db-switcher" })} title={`Switch Database ${chordLabel("Mod+K")}`}>{w.info.database}</button>
        {tableTab && (
          <>
            <span className="sepc">:</span>
            <button onClick={() => bus.emit("focus-sidebar-search")} title="Reveal in sidebar">{tableTab.table.name}</button>
          </>
        )}
        {w.info.tls && (
          <span className="tls" title="TLS">
            <ShieldCheck />
          </span>
        )}
      </div>
      <Segmented value={view} onChange={setView} ariaLabel="View" options={[{ value: "data", label: "Data" }, { value: "structure", label: "Structure" }, { value: "query", label: "Query" }, { value: "map", label: "Map" }]} />
      <div className="field" style={{ visibility: tableTab && tableTab.view === "data" ? "visible" : "hidden" }}>
        <span className="glyph">
          <Search />
        </span>
        <input
          placeholder="Filter rows"
          aria-label="Filter rows"
          value={tableTab?.quickFilter ?? ""}
          onChange={(e) => tableTab && updateTab<TableTab>(workspaceId, tableTab.id, { quickFilter: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Escape" && tableTab) updateTab<TableTab>(workspaceId, tableTab.id, { quickFilter: "" });
          }}
        />
      </div>
      <div className="right">
        <button className="icon-btn" title={`Reload ${chordLabel("Mod+R")}`} onClick={() => bus.emit("reload")}>
          <RotateCw />
        </button>
        <button className="icon-btn danger" title={`Cancel ${chordLabel("Mod+.")}`} disabled={!running} onClick={() => bus.emit("cancel")}>
          <Ban />
        </button>
        <button
          className="icon-btn"
          title={w.safeMode ? `Safe mode on — read-only (${chordLabel("Mod+Shift+L")})` : `Safe mode off — writes allowed (${chordLabel("Mod+Shift+L")})`}
          aria-pressed={w.safeMode}
          onClick={() => void toggleSafeMode()}
          style={w.safeMode ? undefined : { color: "var(--orange)" }}
        >
          {w.safeMode ? <Lock /> : <LockOpen />}
        </button>
        <button className="icon-btn" title={`Console ${chordLabel("Mod+Shift+C")}`} aria-pressed={consoleVisible} onClick={toggleConsole}>
          <PanelBottom />
        </button>
        <button className="icon-btn" title={`Keyboard Shortcuts ${chordLabel("Mod+/")}`} onClick={() => setOverlay({ kind: "shortcuts" })}>
          <Keyboard />
        </button>
        <button className="icon-btn" title={`Inspector ${chordLabel("Mod+I")}`} aria-pressed={inspectorVisible} onClick={toggleInspector}>
          <PanelRight />
        </button>
      </div>
    </div>
  );
}
