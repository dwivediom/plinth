import { useEffect, useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import { invoke } from "../../ipc/client";
import type { ConsoleEntry } from "../../ipc/types";
import { formatDuration, timeOfDay } from "../../lib/format";
import { useConsole } from "../../state/console";
import { contextMenu, toast } from "../../state/overlays";
import { useWorkspaces } from "../../state/workspaces";

export function HistoryPane({ workspaceId }: { workspaceId: string }) {
  const w = useWorkspaces((s) => s.byId[workspaceId]);
  const openQuery = useWorkspaces((s) => s.openQuery);
  const live = useConsole((s) => s.entries);
  const [base, setBase] = useState<ConsoleEntry[]>([]);
  const [q, setQ] = useState("");
  const connectionId = w?.info.connectionId;

  useEffect(() => {
    if (!connectionId) return;
    let alive = true;
    invoke("history_list", { connectionId, limit: 200 })
      .then((r) => alive && setBase(r))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [connectionId]);

  const entries = useMemo(() => {
    const map = new Map<number, ConsoleEntry>();
    for (const e of base) map.set(e.id, e);
    for (const e of live) if (e.connectionId === connectionId && e.source === "user") map.set(e.id, e);
    let all = Array.from(map.values()).sort((a, b) => b.id - a.id);
    if (q.trim()) all = all.filter((e) => e.sql.toLowerCase().includes(q.toLowerCase()));
    return all;
  }, [base, live, connectionId, q]);

  return (
    <>
      <div className="head" style={{ paddingTop: 0 }}>
        <div className="field small" style={{ height: 22 }}>
          <span className="glyph">
            <Search />
          </span>
          <input value={q} placeholder="Search history" aria-label="Search history" onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setQ("")} />
          {q && (
            <button className="clear" aria-label="Clear" onClick={() => setQ("")}>
              <X />
            </button>
          )}
        </div>
      </div>
      <div className="tree" role="list" aria-label="Query history">
        {!entries.length && <div className="none">{q ? "No matching statements" : "No statements yet"}</div>}
        {entries.map((e) => (
          <button
            key={e.id}
            role="listitem"
            className="srow hrow"
            onClick={() => openQuery(workspaceId, e.sql)}
            onContextMenu={(ev) =>
              contextMenu(ev, [
                { label: "Open in Query Tab", onSelect: () => openQuery(workspaceId, e.sql) },
                { label: "Copy SQL", onSelect: () => void navigator.clipboard.writeText(e.sql).then(() => toast("Copied SQL")) },
              ])
            }
            title={e.sql}
          >
            <span className="sql">{e.sql}</span>
            <span className="meta">
              <span>{timeOfDay(e.at)}</span>
              <span>{formatDuration(e.durationMs)}</span>
              {e.rows != null && <span>{e.rows} rows</span>}
              {e.error && <span className="err">error</span>}
            </span>
          </button>
        ))}
      </div>
    </>
  );
}
