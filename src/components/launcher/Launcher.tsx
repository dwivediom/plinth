import { useEffect, useMemo, useRef, useState } from "react";
import { ArchiveRestore, Braces, DatabaseBackup, Info, Plug, Plus, Search, X } from "lucide-react";
import type { ConnectionProfile } from "../../ipc/types";
import { fuzzyMatch, highlightChunks } from "../../lib/fuzzy";
import { envColor } from "../../lib/format";
import { tileFor } from "../../lib/drivers";
import { isTauri } from "../../ipc/client";
import { useConnections } from "../../state/connections";
import { confirm, contextMenu, prompt, toast } from "../../state/overlays";
import { useUi } from "../../state/ui";
import { useWorkspaces } from "../../state/workspaces";

declare const __APP_VERSION__: string;

interface Group {
  title: string | null;
  items: { c: ConnectionProfile; indices: number[] }[];
}

/** `host : database` / `file.sqlite` — the second line of a connection row. */
function subtitle(c: ConnectionProfile): string {
  if (c.driver === "sqlite") return c.filePath ?? "";
  const host = c.host ?? "";
  return c.database ? `${host} : ${c.database}` : host;
}

export function Launcher() {
  const list = useConnections((s) => s.list);
  const groupsExtra = useConnections((s) => s.groups);
  const loading = useConnections((s) => s.loading);
  const remove = useConnections((s) => s.remove);
  const save = useConnections((s) => s.save);
  const launch = useWorkspaces((s) => s.launch);
  const opening = useWorkspaces((s) => s.opening);
  const hasWorkspaces = useWorkspaces((s) => s.order.length > 0);
  const setOverlay = useUi((s) => s.setOverlay);
  const setShowLauncher = useUi((s) => s.setShowLauncher);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const groups = useMemo<Group[]>(() => {
    const match = (c: ConnectionProfile) => (q ? fuzzyMatch(q, `${c.name} ${subtitle(c)}`) : { indices: [] as number[] });
    const byGroup = new Map<string | null, Group["items"]>();
    const sorted = [...list].sort((a, b) => a.name.localeCompare(b.name));
    for (const c of sorted) {
      const m = match(c);
      if (!m) continue;
      const key = c.folder?.trim() || null;
      if (!byGroup.has(key)) byGroup.set(key, []);
      byGroup.get(key)!.push({ c, indices: m.indices.filter((i) => i < c.name.length) });
    }
    for (const g of groupsExtra) if (!byGroup.has(g) && !q) byGroup.set(g, []);
    const out: Group[] = [];
    const ungrouped = byGroup.get(null);
    if (ungrouped?.length) out.push({ title: null, items: ungrouped });
    for (const [title, items] of [...byGroup.entries()].filter(([k]) => k !== null).sort((a, b) => (a[0] as string).localeCompare(b[0] as string))) {
      out.push({ title, items });
    }
    return out;
  }, [list, groupsExtra, q]);

  const flat = groups.flatMap((g) => g.items.map((i) => i.c));
  useEffect(() => {
    if (!sel || !flat.some((c) => c.id === sel)) setSel(flat[0]?.id ?? null);
  }, [flat, sel]);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  /** A connection opens in its own window; this one stays the manager. */
  const connect = (c: ConnectionProfile) => void launch(c.id, c.database ?? null);

  const create = () => setOverlay({ kind: "driver-picker" });
  const edit = (c: ConnectionProfile) => setOverlay({ kind: "connection-sheet", profile: c, connectAfter: false });
  const duplicate = (c: ConnectionProfile) => void save({ ...c, id: "", name: `${c.name} copy`, lastUsedAt: undefined });
  const moveToGroup = async (c: ConnectionProfile) => {
    const name = await prompt("Move to group (empty for none)", c.folder ?? "", "Production");
    if (name === null) return;
    void save({ ...c, folder: name.trim() || undefined });
  };
  const del = async (c: ConnectionProfile) => {
    const r = await confirm({
      title: `Delete “${c.name}”?`,
      message: "The saved password is removed from the keychain as well.",
      buttons: [
        { label: "Cancel", value: "cancel", role: "cancel" },
        { label: "Delete", value: "delete", role: "destructive" },
      ],
    });
    if (r === "delete") void remove(c.id);
  };
  const soon = (what: string) => toast(`${what} arrives with import/export in a later phase.`, "info");

  const onKey = (e: React.KeyboardEvent) => {
    const i = flat.findIndex((c) => c.id === sel);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel(flat[Math.min(flat.length - 1, i + 1)]?.id ?? null);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel(flat[Math.max(0, i - 1)]?.id ?? null);
    } else if (e.key === "Enter") {
      const c = flat[i];
      if (c) connect(c);
    } else if (e.key === "Escape" && q) {
      setQ("");
    } else if ((e.key === "Backspace" || e.key === "Delete") && !q && flat[i] && document.activeElement !== inputRef.current) {
      void del(flat[i]);
    }
  };

  return (
    <div className="launcher" onKeyDown={onKey}>
      <div className="lights-pad" data-tauri-drag-region />
      {hasWorkspaces && (
        <button className="btn launcher-back" onClick={() => setShowLauncher(false)}>
          <X /> Back to workspace
        </button>
      )}
      <div className="welcome two-pane" role="dialog" aria-label="Connections">
        <aside className="brand" data-tauri-drag-region>
          <div className="mark" aria-hidden>
            <span className="slab" />
            <span className="base" />
          </div>
          <h1>Plinth</h1>
          <div className="version">Version {__APP_VERSION__}</div>
          <div className="license">Open source · AGPL-3.0</div>
          <div className="brand-actions">
            <button className="btn big" onClick={() => setOverlay({ kind: "guide" })}>
              <Info /> Guide &amp; Features
            </button>
            <button className="btn big" onClick={() => setOverlay({ kind: "json-scratch" })}>
              <Braces /> JSON Viewer
            </button>
            <button className="btn big" onClick={() => soon("Backup")}>
              <DatabaseBackup /> Backup Database
            </button>
            <button className="btn big" onClick={() => soon("Restore")}>
              <ArchiveRestore /> Restore Database
            </button>
            <button className="btn big" onClick={create}>
              <Plug /> Create Connection
            </button>
          </div>
        </aside>
        <section className="conns">
          <div className="conns-head" data-tauri-drag-region>
            <button className="icon-btn" onClick={create} title="New connection" aria-label="New connection">
              <Plus />
            </button>
            <div className="field">
              <span className="glyph">
                <Search />
              </span>
              <input ref={inputRef} placeholder="Search for connection…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search connections" />
            </div>
          </div>
          <div className="list" role="listbox" aria-label="Connections" tabIndex={0}>
            {!list.length && !loading && (
              <div className="empty-big">
                <div style={{ font: "var(--t-title-3)" }}>No Connections</div>
                <small style={{ color: "var(--label-3)" }}>Click + or Create Connection to add one.</small>
              </div>
            )}
            {list.length > 0 && !flat.length && <div className="empty">No connections match “{q}”</div>}
            {groups.map((g) => (
              <div key={g.title ?? "__none"}>
                {g.title && <div className="grp">{g.title}</div>}
                {g.title && !g.items.length && <div className="empty small">Empty group</div>}
                {g.items.map(({ c, indices }) => {
                  const tile = tileFor(c.driver, c.port);
                  const env = envColor(c.environment);
                  return (
                    <div
                      key={c.id}
                      role="option"
                      aria-selected={sel === c.id}
                      className="crow"
                      onClick={() => setSel(c.id)}
                      onDoubleClick={() => connect(c)}
                      onContextMenu={(e) => {
                        setSel(c.id);
                        contextMenu(e, [
                          { label: "Open", onSelect: () => connect(c) },
                          { label: "Edit…", onSelect: () => edit(c) },
                          { label: "Duplicate", onSelect: () => duplicate(c) },
                          { label: "Move to Group…", onSelect: () => void moveToGroup(c) },
                          { separator: true },
                          { label: "Delete…", destructive: true, onSelect: () => void del(c) },
                        ]);
                      }}
                    >
                      <span className="badge" style={{ background: tile.color }} aria-hidden>
                        {tile.mono}
                      </span>
                      <span className="text">
                        <span className="name">
                          {highlightChunks(c.name, indices).map((ch, j) => (ch.hit ? <mark key={j}>{ch.text}</mark> : <span key={j}>{ch.text}</span>))}
                          {env && <span className="env" style={{ background: env }} title={c.environment} />}
                        </span>
                        <span className="sub">{subtitle(c)}</span>
                      </span>
                      {opening && sel === c.id && <span className="sub">Connecting…</span>}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </section>
      </div>
      {!isTauri && <div style={{ position: "absolute", bottom: 12, left: 0, right: 0, textAlign: "center", font: "var(--t-caption)", color: "var(--label-3)" }}>Browser preview · mock backend · window.plinthMock for test controls</div>}
    </div>
  );
}
