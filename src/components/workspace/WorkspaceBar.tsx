import { X } from "lucide-react";
import { envColor } from "../../lib/format";
import { chordLabel } from "../../lib/keys";
import { confirm, contextMenu } from "../../state/overlays";
import { isTabDirty } from "../../state/types";
import { useUi } from "../../state/ui";
import { useWorkspaces } from "../../state/workspaces";

/** One tab per open workspace (connection : database). Native window tabs replace this on macOS later. */
export function WorkspaceBar() {
  const order = useWorkspaces((s) => s.order);
  const byId = useWorkspaces((s) => s.byId);
  const activeId = useWorkspaces((s) => s.activeId);
  const setActive = useWorkspaces((s) => s.setActive);
  const close = useWorkspaces((s) => s.close);
  const setOverlay = useUi((s) => s.setOverlay);

  const closeWs = async (id: string) => {
    const w = byId[id];
    if (!w) return;
    const dirty = w.tabs.filter(isTabDirty).length;
    if (dirty) {
      const r = await confirm({
        title: `Close ${w.info.connectionName} : ${w.info.database}?`,
        message: `${dirty} tab${dirty === 1 ? " has" : "s have"} unsaved changes. Drafts are kept and restored when you reopen this workspace, but pending grid edits are lost.`,
        buttons: [
          { label: "Cancel", value: "cancel", role: "cancel" },
          { label: "Close", value: "close", role: "destructive" },
        ],
      });
      if (r !== "close") return;
    }
    void close(id);
  };

  return (
    <div className="wsbar" role="tablist" aria-label="Workspaces">
      {order.map((id) => {
        const w = byId[id];
        if (!w) return null;
        const env = envColor(w.info.environment);
        return (
          <div
            key={id}
            role="tab"
            aria-selected={id === activeId}
            className="ws"
            onClick={() => setActive(id)}
            onContextMenu={(e) =>
              contextMenu(e, [
                { label: "Switch Database…", shortcut: chordLabel("Mod+K"), onSelect: () => { setActive(id); setOverlay({ kind: "db-switcher" }); } },
                { label: "Reconnect", onSelect: () => void useWorkspaces.getState().reconnect(id) },
                { separator: true },
                { label: "Close Workspace", onSelect: () => void closeWs(id) },
              ])
            }
          >
            <span className={`env${env ? "" : " none"}`} style={{ background: env ?? undefined }} />
            <span className="t">
              {w.info.connectionName} : {w.info.database}
            </span>
            <button className="x" aria-label="Close workspace" onClick={(e) => { e.stopPropagation(); void closeWs(id); }}>
              <X />
            </button>
          </div>
        );
      })}
    </div>
  );
}
