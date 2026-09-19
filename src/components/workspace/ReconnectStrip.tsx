import { useWorkspaces } from "../../state/workspaces";

export function ReconnectStrip({ workspaceId }: { workspaceId: string }) {
  const w = useWorkspaces((s) => s.byId[workspaceId]);
  const reconnect = useWorkspaces((s) => s.reconnect);
  if (!w) return null;
  const msg = w.connDetail ?? (w.connState === "down" ? `Connection to ${w.info.connectionName} dropped — reconnecting` : `Connection to ${w.info.connectionName} is degraded`);
  return (
    <div className="reconnect" role="alert">
      <span className={`dot ${w.connState === "down" ? "r" : "o"}`} />
      <span className="truncate">{msg}</span>
      <button className="btn" onClick={() => void reconnect(workspaceId)}>
        Reconnect now
      </button>
    </div>
  );
}
