import { useMemo, useState } from "react";
import { Bookmark, Folder, Search, X } from "lucide-react";
import type { SavedQuery } from "../../ipc/types";
import { fuzzyMatch, highlightChunks } from "../../lib/fuzzy";
import { relativeTime } from "../../lib/format";
import { confirm, contextMenu, prompt, toast } from "../../state/overlays";
import { useSaved } from "../../state/saved";
import { useWorkspaces } from "../../state/workspaces";

export function QueriesPane({ workspaceId }: { workspaceId: string }) {
  const w = useWorkspaces((s) => s.byId[workspaceId]);
  const openSaved = useWorkspaces((s) => s.openSaved);
  const activeTab = useWorkspaces((s) => s.byId[workspaceId]?.tabs.find((t) => t.id === s.byId[workspaceId]?.activeTabId));
  const list = useSaved((s) => s.list);
  const save = useSaved((s) => s.save);
  const remove = useSaved((s) => s.remove);
  const [q, setQ] = useState("");

  const folders = useMemo(() => {
    const mine = list.filter((x) => !w || x.connectionId == null || x.connectionId === w.info.connectionId);
    const matched = mine.map((x) => ({ x, m: q ? fuzzyMatch(q, x.name) : { indices: [] as number[] } })).filter((y) => y.m);
    const map = new Map<string, { x: SavedQuery; indices: number[] }[]>();
    for (const { x, m } of matched) {
      const f = x.folder ?? (x.connectionId == null ? "Shared" : "Queries");
      if (!map.has(f)) map.set(f, []);
      map.get(f)!.push({ x, indices: m!.indices });
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [list, q, w]);

  const menu = (x: SavedQuery) => [
    { label: "Open", onSelect: () => openSaved(workspaceId, x) },
    { label: "Open in New Tab", onSelect: () => openSaved(workspaceId, x, { newTab: true, pin: true }) },
    { separator: true },
    { label: "Rename…", onSelect: () => void prompt("Rename Query", x.name).then((n) => { if (n) void save({ ...x, name: n }); }) },
    { label: "Move to Folder…", onSelect: () => void prompt("Folder", x.folder ?? "", "Leave empty for none").then((f) => { if (f !== null) void save({ ...x, folder: f || null }); }) },
    { label: x.connectionId ? "Share Across Connections" : "Limit to This Connection", onSelect: () => void save({ ...x, connectionId: x.connectionId ? null : (w?.info.connectionId ?? null) }) },
    { label: "Copy SQL", onSelect: () => void navigator.clipboard.writeText(x.sql).then(() => toast("Copied SQL")) },
    { separator: true },
    {
      label: "Delete…",
      destructive: true,
      onSelect: () =>
        void confirm({ title: `Delete “${x.name}”?`, buttons: [{ label: "Cancel", value: "cancel", role: "cancel" }, { label: "Delete", value: "del", role: "destructive" }] }).then((r) => { if (r === "del") void remove(x.id); }),
    },
  ];

  return (
    <>
      <div className="head" style={{ paddingTop: 0 }}>
        <div className="field small" style={{ height: 22 }}>
          <span className="glyph">
            <Search />
          </span>
          <input value={q} placeholder="Search queries" aria-label="Search queries" onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setQ("")} />
          {q && (
            <button className="clear" aria-label="Clear" onClick={() => setQ("")}>
              <X />
            </button>
          )}
        </div>
      </div>
      <div className="tree" role="tree" aria-label="Saved queries">
        {!folders.length && <div className="none">{q ? `No queries match “${q}”` : "No saved queries yet — press ⌘S in a query tab."}</div>}
        {folders.map(([folder, items]) => (
          <div key={folder} role="group">
            <div className="grp">
              <Folder style={{ width: 11, height: 11 }} /> {folder}
            </div>
            {items.map(({ x, indices }) => (
              <button
                key={x.id}
                role="treeitem"
                className="srow qrow"
                aria-selected={activeTab?.kind === "saved" && activeTab.savedId === x.id}
                onClick={(e) => openSaved(workspaceId, x, { newTab: e.metaKey || e.ctrlKey, pin: e.metaKey || e.ctrlKey })}
                onDoubleClick={() => openSaved(workspaceId, x, { pin: true })}
                onContextMenu={(e) => contextMenu(e, menu(x))}
                title={x.sql}
              >
                <span className="ic">
                  <Bookmark />
                </span>
                <span className="name">{highlightChunks(x.name, indices).map((c, j) => (c.hit ? <mark key={j}>{c.text}</mark> : <span key={j}>{c.text}</span>))}</span>
                <span className="cnt">{relativeTime(x.updatedAt)}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}
