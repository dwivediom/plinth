import { useEffect, useState } from "react";
import { invoke } from "../../ipc/client";
import { driverLabel, formatCount, formatUptime } from "../../lib/format";
import { chordLabel } from "../../lib/keys";
import { useData } from "../../state/data";
import { useUi } from "../../state/ui";
import { useWorkspaces } from "../../state/workspaces";

export function StatusBar({ workspaceId }: { workspaceId: string }) {
  const w = useWorkspaces((s) => s.byId[workspaceId]);
  const tab = useWorkspaces((s) => s.byId[workspaceId]?.tabs.find((t) => t.id === s.byId[workspaceId]?.activeTabId));
  const tableData = useData((s) => (tab ? s.tables[tab.id] : undefined));
  const rowsLoaded = useData((s) => (tableData?.result?.cursorId ? s.cursors[tableData.result.cursorId]?.rows.length : undefined));
  const setTable = useData((s) => s.setTable);
  const setOverlay = useUi((s) => s.setOverlay);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  if (!w) return null;

  const state = w.connState;
  const dot = state === "up" ? "g" : state === "connecting" ? "o pulse" : state === "degraded" ? "o" : "r";
  const tunnel = w.info.driver === "sqlite" ? "local" : w.info.tls ? "TLS" : "plain";
  const left = state === "up" ? `${w.info.connectionName} · ${tunnel} · ${formatUptime(Date.now() - w.openedAt)}` : (w.connDetail ?? (state === "connecting" ? "Connecting…" : "Disconnected"));

  const estimate = tableData?.schema?.rowEstimate ?? null;
  const exact = tableData?.exactCount;
  const countExact = async () => {
    if (!tab || tab.kind !== "table" || tableData?.counting) return;
    setTable(tab.id, { counting: true });
    try {
      const n = await invoke("table_count", { workspaceId, table: tab.table, exact: true });
      setTable(tab.id, { exactCount: n, counting: false });
    } catch {
      setTable(tab.id, { counting: false });
    }
  };

  return (
    <div className="status" role="status">
      <span className="l">
        <span className={`dot ${dot}`} />
        <span className={`truncate${state === "down" ? " red" : ""}`} title={`${driverLabel[w.info.driver]}${w.info.serverVersion ? ` ${w.info.serverVersion}` : ""} · ${w.info.database}`}>{left}</span>
      </span>
      <span className="r">
        {tab?.kind === "table" && tab.selectedRow != null && rowsLoaded != null && <span>{`row ${tab.selectedRow + 1} of ${formatCount(rowsLoaded)}`}</span>}
        {tab?.kind === "table" && (
          <button onClick={() => void countExact()} title="Click for an exact count" disabled={tableData?.counting}>
            {tableData?.counting ? "Counting…" : exact != null ? `${formatCount(exact)} rows` : estimate != null ? `~${formatCount(estimate)} rows` : rowsLoaded != null ? `${formatCount(rowsLoaded)} rows` : ""}
          </button>
        )}
        <button onClick={() => setOverlay({ kind: "palette" })} title="Open Anything">
          {chordLabel("Mod+P")}
        </button>
      </span>
    </div>
  );
}
