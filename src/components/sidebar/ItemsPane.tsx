import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Columns3, Search, Star, X } from "lucide-react";
import { ObjectIcon } from "../../components/common/Icons";
import type { ObjectInfo, ObjectKind } from "../../ipc/types";
import { useBus } from "../../lib/bus";
import { compactCount } from "../../lib/format";
import { compareMatches, fuzzyMatch, highlightChunks } from "../../lib/fuzzy";
import { chordLabel, isMac } from "../../lib/keys";
import { confirm, contextMenu, toast } from "../../state/overlays";
import { useWorkspaces } from "../../state/workspaces";
import { useUi } from "../../state/ui";
import { useAi } from "../../state/ai";

/** A stable empty array: a fresh one each render restarts the selector. */
const EMPTY_PINS: string[] = [];

type Row =
  | { kind: "object"; key: string; obj: ObjectInfo; indices: number[]; fav?: boolean }
  | { kind: "column"; key: string; obj: ObjectInfo; column: string; indices: number[] };

interface Group {
  key: string;
  title: string;
  rows: Row[];
  collapsible: boolean;
}

const kindTitle: Record<ObjectKind, string> = { table: "Tables", view: "Views", "materialized-view": "Materialized Views", function: "Functions", sequence: "Sequences" };
const kindOrder: ObjectKind[] = ["table", "view", "materialized-view", "function", "sequence"];

function loadCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem("plinth:sidebar:collapsed") ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}
const collapsedSet = loadCollapsed();
function persistCollapsed() {
  try {
    localStorage.setItem("plinth:sidebar:collapsed", JSON.stringify(Array.from(collapsedSet)));
  } catch {
    /* ignore */
  }
}

export function ItemsPane({ workspaceId }: { workspaceId: string }) {
  const w = useWorkspaces((s) => s.byId[workspaceId]);
  const openObject = useWorkspaces((s) => s.openObject);
  const toggleFavorite = useWorkspaces((s) => s.toggleFavorite);
  const openQuery = useWorkspaces((s) => s.openQuery);
  const activeTab = useWorkspaces((s) => s.byId[workspaceId]?.tabs.find((t) => t.id === s.byId[workspaceId]?.activeTabId));
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [, bump] = useState(0);
  const [showSystem, setShowSystem] = useState(false);
  const [hiddenKinds, setHiddenKinds] = useState<Set<ObjectKind>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const searchFocused = useRef(false);

  useBus(
    "focus-sidebar-search",
    useCallback(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, []),
  );

  const schema = w?.schema;
  const favorites = w?.favorites ?? [];
  // The AI's context list, so the sidebar can put a table into it — the same
  // list the chat's @mentions fill.
  const pinned = useAi((s) => s.pins[workspaceId] ?? EMPTY_PINS);
  const pin = useAi((s) => s.pin);
  const unpin = useAi((s) => s.unpin);

  const groups = useMemo<Group[]>(() => {
    if (!schema) return [];
    const query = q.trim();
    const out: Group[] = [];
    const objKey = (o: ObjectInfo) => `${o.schema}.${o.name}`;
    const allObjects = schema.schemas.filter((s) => showSystem || !s.isSystem).flatMap((s) => s.objects).filter((o) => !hiddenKinds.has(o.kind));

    if (!query) {
      const favRows: Row[] = allObjects.filter((o) => favorites.includes(objKey(o))).map((o) => ({ kind: "object", key: `fav:${objKey(o)}`, obj: o, indices: [], fav: true }));
      if (favRows.length) out.push({ key: "favorites", title: "Favorites", rows: favRows, collapsible: true });
      for (const s of schema.schemas) {
        if (s.isSystem && !showSystem) continue;
        for (const k of kindOrder) {
          const objs = s.objects.filter((o) => o.kind === k && !hiddenKinds.has(k));
          if (!objs.length) continue;
          const single = kindOrder.filter((kk) => s.objects.some((o) => o.kind === kk && !hiddenKinds.has(kk))).length === 1 && k === "table";
          out.push({ key: `${s.name}/${k}`, title: single ? s.name : `${s.name} › ${kindTitle[k]}`, rows: objs.map((o) => ({ kind: "object", key: objKey(o), obj: o, indices: [] })), collapsible: true });
        }
      }
      return out;
    }

    // searching: rank objects, group by schema, then a COLUMNS group
    const matched = allObjects
      .map((o) => ({ o, m: fuzzyMatch(query, o.name) }))
      .filter((x): x is { o: ObjectInfo; m: NonNullable<ReturnType<typeof fuzzyMatch>> } => !!x.m)
      .sort((a, b) => compareMatches(a.m, b.m) || Number(favorites.includes(objKey(b.o))) - Number(favorites.includes(objKey(a.o))) || (b.o.rowEstimate ?? 0) - (a.o.rowEstimate ?? 0));
    const bySchema = new Map<string, Row[]>();
    for (const { o, m } of matched) {
      let rows = bySchema.get(o.schema);
      if (!rows) bySchema.set(o.schema, (rows = []));
      rows.push({ kind: "object", key: objKey(o), obj: o, indices: m.indices });
    }
    for (const [s, rows] of bySchema) out.push({ key: `s:${s}`, title: s, rows, collapsible: false });
    const colRows: Row[] = [];
    for (const c of schema.columns) {
      const m = fuzzyMatch(query, c.column);
      if (!m) continue;
      const o = allObjects.find((x) => x.schema === c.schema && x.name === c.table);
      if (!o) continue;
      colRows.push({ kind: "column", key: `col:${c.schema}.${c.table}.${c.column}`, obj: o, column: c.column, indices: m.indices });
      if (colRows.length >= 40) break;
    }
    if (colRows.length) out.push({ key: "columns", title: "Columns", rows: colRows, collapsible: false });
    return out;
  }, [schema, q, favorites, showSystem, hiddenKinds]);

  const visibleRows = useMemo(() => groups.flatMap((g) => (q || !collapsedSet.has(g.key) ? g.rows : [])), [groups, q]);
  const activeKey = activeTab?.kind === "table" ? `${activeTab.table.schema ?? ""}.${activeTab.table.name}` : null;
  const selectedKey = cursor ?? activeKey;

  useEffect(() => {
    setCursor(null);
  }, [q]);

  const open = useCallback(
    (row: Row, opts: { newTab?: boolean; pin?: boolean; view?: "data" | "structure" }) => {
      if (row.obj.kind === "function" || row.obj.kind === "sequence") {
        // no data view for these yet — show the structure/DDL
        openObject(workspaceId, row.obj, { ...opts, view: "structure" });
      } else openObject(workspaceId, row.obj, opts);
      setCursor(null);
    },
    [openObject, workspaceId],
  );

  const onKey = (e: ReactKeyboardEvent, fromField: boolean) => {
    const i = visibleRows.findIndex((r) => r.key === selectedKey);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = visibleRows[Math.min(visibleRows.length - 1, fromField ? 0 : i + 1)];
      if (next) {
        setCursor(next.key);
        treeRef.current?.focus();
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (i <= 0) {
        inputRef.current?.focus();
        setCursor(null);
      } else setCursor(visibleRows[i - 1].key);
    } else if (e.key === "Enter") {
      const row = visibleRows[i >= 0 ? i : 0];
      if (row) {
        e.preventDefault();
        open(row, { newTab: e.metaKey || e.ctrlKey, pin: e.metaKey || e.ctrlKey, view: e.altKey ? "structure" : undefined });
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (q) setQ("");
      else setCursor(null);
      if (fromField) treeRef.current?.focus();
    }
  };

  useEffect(() => {
    if (!cursor) return;
    treeRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(cursor)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const menuFor = (row: Row) => {
    const key = `${row.obj.schema}.${row.obj.name}`;
    const isFav = favorites.includes(key);
    const guarded = !w || w.safeMode || w.info.policy !== "full";
    return [
      { label: "Open", onSelect: () => open(row, {}) },
      { label: "Open in New Tab", shortcut: chordLabel("Mod+Enter"), onSelect: () => open(row, { newTab: true, pin: true }) },
      { label: "Open Structure", shortcut: chordLabel("Alt+Enter"), onSelect: () => open(row, { view: "structure" }) },
      { separator: true },
      { label: isFav ? "Remove from Favorites" : "Add to Favorites", onSelect: () => toggleFavorite(workspaceId, { schema: row.obj.schema, name: row.obj.name }) },
      // The AI answers better about tables it has been shown. Pinning is also
      // reachable by @mentioning the table in the chat — this is the same list.
      { label: pinned.includes(key) ? "Remove from AI Context" : "Add to AI Context", onSelect: () => (pinned.includes(key) ? unpin(workspaceId, key) : pin(workspaceId, key)) },
      { label: "Copy Name", onSelect: () => void navigator.clipboard.writeText(key).then(() => toast(`Copied ${key}`)) },
      { label: "Query Table", onSelect: () => openQuery(workspaceId, `select * from ${key}\nlimit 100;`) },
      { label: "Show DDL", onSelect: () => open(row, { view: "structure" }) },
      { separator: true },
      { label: "Truncate…", destructive: true, disabled: guarded || row.obj.kind !== "table", onSelect: () => void guardedStatement(`TRUNCATE ${key}`, row.obj.name) },
      { label: "Drop…", destructive: true, disabled: guarded, onSelect: () => void guardedStatement(`DROP ${row.obj.kind === "view" ? "VIEW" : "TABLE"} ${key}`, row.obj.name) },
    ];
  };

  const guardedStatement = async (sql: string, name: string) => {
    const r = await confirm({
      title: `${sql.split(" ")[0] === "DROP" ? "Drop" : "Truncate"} “${name}”?`,
      message: `This runs ${sql} on ${w?.info.connectionName}. It cannot be undone.`,
      buttons: [
        { label: "Cancel", value: "cancel", role: "cancel" },
        { label: "Open in Query Tab", value: "ok", role: "destructive" },
      ],
    });
    if (r === "ok") openQuery(workspaceId, `${sql};`);
  };

  const filterMenu = (e: React.MouseEvent) => {
    contextMenu(e, [
      ...kindOrder.map((k) => ({ label: kindTitle[k], checked: !hiddenKinds.has(k), onSelect: () => setHiddenKinds((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; }) })),
      { separator: true },
      { label: "Show system schemas", checked: showSystem, onSelect: () => setShowSystem((s) => !s) },
    ]);
  };

  const renderRow = (row: Row): ReactNode => {
    const isSel = row.key === selectedKey || (row.kind === "object" && row.fav && `${row.obj.schema}.${row.obj.name}` === selectedKey && cursor === null);
    const name = row.kind === "column" ? row.column : row.obj.name;
    const label = highlightChunks(name, row.indices).map((c, j) => (c.hit ? <mark key={j}>{c.text}</mark> : <span key={j}>{c.text}</span>));
    return (
      <button
        key={row.key}
        data-key={row.key}
        role="treeitem"
        aria-selected={isSel}
        className={`srow${row.kind === "column" ? " sub" : ""}`}
        onClick={(e) => open(row, { newTab: e.metaKey || e.ctrlKey, pin: e.metaKey || e.ctrlKey })}
        onDoubleClick={() => open(row, { pin: true })}
        onContextMenu={(e) => {
          setCursor(row.key);
          contextMenu(e, menuFor(row));
        }}
        title={row.kind === "column" ? `${row.obj.schema}.${row.obj.name}.${row.column}` : `${row.obj.schema}.${row.obj.name}`}
      >
        <span className={`ic${row.kind === "column" ? " dim" : ""}`}>{row.kind === "column" ? <Columns3 /> : row.fav ? <Star /> : <ObjectIcon kind={row.obj.kind} />}</span>
        <span className="name">
          {row.kind === "column" ? (
            <>
              <span className="secondary">{row.obj.name}.</span>
              {label}
            </>
          ) : (
            label
          )}
        </span>
        {row.kind === "object" && row.obj.rowEstimate != null && <span className="cnt">{compactCount(row.obj.rowEstimate)}</span>}
      </button>
    );
  };

  return (
    <>
      <div className="head" style={{ paddingTop: 0 }}>
        <div className="field small" style={{ height: 22 }}>
          <span className="glyph">
            <Search />
          </span>
          <input
            ref={inputRef}
            value={q}
            placeholder="Search tables"
            aria-label="Search tables"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => onKey(e, true)}
            onFocus={() => {
              searchFocused.current = true;
              bump((x) => x + 1);
            }}
            onBlur={() => {
              searchFocused.current = false;
              bump((x) => x + 1);
            }}
          />
          {q ? (
            <button className="clear" aria-label="Clear" onClick={() => { setQ(""); inputRef.current?.focus(); }}>
              <X />
            </button>
          ) : (
            !searchFocused.current && <span className="kbd">{isMac ? "⌘⇧O" : "Ctrl+⇧O"}</span>
          )}
        </div>
        {w?.schemaLoading && <progress className="thin" />}
      </div>
      <div ref={treeRef} className="tree" role="tree" tabIndex={0} onKeyDown={(e) => onKey(e, false)} aria-label="Database objects">
        {w?.schemaError && <div className="none error-text">{w.schemaError}</div>}
        {!w?.schemaLoading && schema && !groups.length && <div className="none">{q ? `No tables match “${q}”` : "No objects"}</div>}
        {groups.map((g) => {
          const collapsed = !q && collapsedSet.has(g.key);
          return (
            <div key={g.key} role="group" aria-label={g.title}>
              <div className="grp" onContextMenu={filterMenu}>
                {g.collapsible && (
                  <button
                    aria-label={collapsed ? "Expand" : "Collapse"}
                    aria-expanded={!collapsed}
                    onClick={() => {
                      if (collapsedSet.has(g.key)) collapsedSet.delete(g.key);
                      else collapsedSet.add(g.key);
                      persistCollapsed();
                      bump((x) => x + 1);
                    }}
                  >
                    {collapsed ? <ChevronRight /> : <ChevronDown />}
                  </button>
                )}
                <span>{g.title}</span>
              </div>
              {!collapsed && g.rows.map(renderRow)}
            </div>
          );
        })}
      </div>
    </>
  );
}

export const useSidebarIsVisible = () => useUi((s) => s.sidebarVisible);
