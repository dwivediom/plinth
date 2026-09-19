import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Columns3, Funnel, Lock, Plus, Settings2, TriangleAlert } from "lucide-react";
import { errorMessage, invoke } from "../../ipc/client";
import type { Cell, ChangeSet, ColumnDesc, Sort } from "../../ipc/types";
import { useBus } from "../../lib/bus";
import { cellText, formatCount } from "../../lib/format";
import { chordLabel } from "../../lib/keys";
import { releaseCursor, useData } from "../../state/data";
import { confirm, contextMenu, prompt, toast } from "../../state/overlays";
import { changeCount, pkKey, type TableTab } from "../../state/types";
import { useUi } from "../../state/ui";
import { useWorkspaces } from "../../state/workspaces";
import { useConnections } from "../../state/connections";
import { usePopoverDismiss } from "../../components/common/Overlays";
import { isNumericType } from "../../ipc/types";
import { METRICS, isVector, similaritySql } from "../../lib/vector";
import { DataGrid } from "./DataGrid";
import { FilterBar } from "./FilterBar";
import { SaveBar } from "./SaveBar";
import { StructureView } from "./StructureView";

type RowRef = { kind: "insert"; i: number } | { kind: "row"; i: number };

export function TableView({ workspaceId, tabId }: { workspaceId: string; tabId: string }) {
  const w = useWorkspaces((s) => s.byId[workspaceId]);
  const tab = useWorkspaces((s) => s.byId[workspaceId]?.tabs.find((t) => t.id === tabId)) as TableTab | undefined;
  const updateTab = useWorkspaces((s) => s.updateTab);
  const openObject = useWorkspaces((s) => s.openObject);
  const openQuery = useWorkspaces((s) => s.openQuery);
  const openJson = useWorkspaces((s) => s.openJson);
  const setCellChange = useWorkspaces((s) => s.setCellChange);
  const revertChanges = useWorkspaces((s) => s.revertChanges);
  const addInsert = useWorkspaces((s) => s.addInsert);
  const updateInsert = useWorkspaces((s) => s.updateInsert);
  const removeInsert = useWorkspaces((s) => s.removeInsert);
  const toggleDelete = useWorkspaces((s) => s.toggleDelete);
  const setRunning = useWorkspaces((s) => s.setRunning);
  const setOverlay = useUi((s) => s.setOverlay);
  const defaultLimit = useUi((s) => s.defaultLimit);

  const data = useData((s) => s.tables[tabId]);
  const setTable = useData((s) => s.setTable);
  const cursorId = data?.result?.cursorId ?? null;
  const cursor = useData((s) => (cursorId ? s.cursors[cursorId] : undefined));
  const ensureCursor = useData((s) => s.ensureCursor);
  const fetchMore = useData((s) => s.fetchMore);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const columnsRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  usePopoverDismiss(columnsOpen, () => setColumnsOpen(false), columnsRef);

  const filters = tab?.filters;
  const sort = tab?.sort;
  const table = tab?.table;
  const limit = tab?.limit === undefined ? defaultLimit : tab.limit;
  const setLimit = (l: number | null) => updateTab<TableTab>(workspaceId, tabId, { limit: l });
  const sig = JSON.stringify({ filters, sort, limit });

  // ── describe once ──
  useEffect(() => {
    if (!table) return;
    let alive = true;
    if (!data?.schema) {
      invoke("table_describe", { workspaceId, table })
        .then((schema) => alive && setTable(tabId, { schema }))
        .catch((e) => alive && setTable(tabId, { error: errorMessage(e) }));
    }
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, tabId, table?.schema, table?.name, !data?.schema]);

  // ── open / reopen the cursor when filters, sort or limit change ──
  const load = useCallback(async (force = false) => {
    if (!table) return;
    const cur = useData.getState().tables[tabId];
    if (!force && cur?.result && !cur.error && cur.sig === sig) return; // already open for this query (tab switch / remount)
    setTable(tabId, { loading: true, error: null, sig });
    setRunning(workspaceId, tabId, true);
    const prev = useData.getState().tables[tabId]?.result?.cursorId;
    try {
      const result = await invoke("table_open", { workspaceId, table, query: { filters: filters ?? [], sort: sort ?? [], limit, offset: null } });
      releaseCursor(prev);
      if (result.error) setTable(tabId, { result, loading: false, error: result.error.message, loadedAt: Date.now() });
      else {
        setTable(tabId, { result, loading: false, loadedAt: Date.now() });
        if (result.cursorId) ensureCursor(result.cursorId);
      }
    } catch (e) {
      setTable(tabId, { loading: false, error: errorMessage(e) });
    } finally {
      setRunning(workspaceId, tabId, false);
    }
  }, [workspaceId, tabId, table, filters, sort, limit, sig, setTable, ensureCursor, setRunning]);

  useEffect(() => {
    void load();
  }, [load]);

  useBus("reload", useCallback(() => { setTable(tabId, { schema: null, exactCount: null }); void load(true); }, [load, setTable, tabId]));
  useBus("toggle-filter-bar", useCallback(() => tab && updateTab<TableTab>(workspaceId, tabId, { showFilterBar: !tab.showFilterBar }), [tab, updateTab, workspaceId, tabId]));

  // ── derived rows ──
  const columns: ColumnDesc[] = data?.result?.columns ?? [];
  const rows = cursor?.rows ?? [];
  const pk = data?.schema?.primaryKey ?? [];
  const hasPk = pk.length > 0;
  const readOnlyReason = !w ? null : w.info.policy === "read-only" ? "policy" : w.safeMode ? "safe" : !hasPk && data?.schema ? "nopk" : data?.schema?.kind === "view" || data?.schema?.kind === "materialized-view" ? "view" : null;
  const editable = !readOnlyReason && !!data?.schema;
  const changes = tab?.changes;
  const nChanges = changes ? changeCount(changes) : 0;

  const colIndex = useMemo(() => new Map(columns.map((c, i) => [c.name, i])), [columns]);
  const pkOf = useCallback(
    (row: Cell[]) => {
      const out: Record<string, Cell> = {};
      for (const k of pk) {
        const i = colIndex.get(k);
        if (i != null) out[k] = row[i];
      }
      return out;
    },
    [pk, colIndex],
  );

  const quick = tab?.quickFilter.trim().toLowerCase() ?? "";
  const filteredIdx = useMemo(() => {
    if (!quick) return null;
    const out: number[] = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      for (let c = 0; c < r.length; c++) {
        if (cellText(r[c], columns[c]?.logical).toLowerCase().includes(quick)) {
          out.push(i);
          break;
        }
      }
    }
    return out;
  }, [quick, rows, columns]);

  const inserts = changes?.inserts ?? [];
  const refs: RowRef[] = useMemo(() => {
    const out: RowRef[] = inserts.map((_, i) => ({ kind: "insert", i }));
    if (filteredIdx) for (const i of filteredIdx) out.push({ kind: "row", i });
    else for (let i = 0; i < rows.length; i++) out.push({ kind: "row", i });
    return out;
  }, [inserts, filteredIdx, rows.length]);

  const displayRows = useMemo(
    () => refs.map((r) => (r.kind === "insert" ? columns.map((c) => (c.name in inserts[r.i].values ? inserts[r.i].values[c.name] : null)) : rows[r.i])),
    [refs, rows, columns, inserts],
  );

  const changeFor = useCallback(
    (ref: RowRef, col: number) => {
      if (!changes || ref.kind !== "row") return undefined;
      const key = `${pkKey(pkOf(rows[ref.i]))}\u0000${columns[col].name}`;
      return changes.updates[key];
    },
    [changes, rows, columns, pkOf],
  );
  const valueAt = useCallback(
    (d: number, col: number) => {
      const ref = refs[d];
      if (!ref) return null;
      if (ref.kind === "insert") return displayRows[d][col];
      const ch = changeFor(ref, col);
      return ch ? ch.value : rows[ref.i][col];
    },
    [refs, displayRows, changeFor, rows],
  );
  const isDirty = useCallback((d: number, col: number) => !!changeFor(refs[d], col) || refs[d]?.kind === "insert", [refs, changeFor]);
  const rowClass = useCallback(
    (d: number) => {
      const ref = refs[d];
      if (!ref) return "";
      if (ref.kind === "insert") return "inserted";
      return changes?.deletes[pkKey(pkOf(rows[ref.i]))] ? "deleted" : "";
    },
    [refs, changes, rows, pkOf],
  );

  const onEdit = useCallback(
    (d: number, col: number, value: Cell) => {
      const ref = refs[d];
      if (!ref || !editable) return;
      const name = columns[col].name;
      if (ref.kind === "insert") updateInsert(workspaceId, tabId, ref.i, name, value);
      else setCellChange(workspaceId, tabId, pkOf(rows[ref.i]), name, value, rows[ref.i][col]);
    },
    [refs, editable, columns, updateInsert, setCellChange, workspaceId, tabId, pkOf, rows],
  );

  const onDeleteRow = useCallback(
    (d: number) => {
      const ref = refs[d];
      if (!ref || !editable) return;
      if (ref.kind === "insert") removeInsert(workspaceId, tabId, ref.i);
      else toggleDelete(workspaceId, tabId, pkOf(rows[ref.i]));
    },
    [refs, editable, removeInsert, toggleDelete, workspaceId, tabId, pkOf, rows],
  );

  const fkFor = useCallback((c: ColumnDesc) => data?.schema?.foreignKeys.find((fk) => fk.columns.length === 1 && fk.columns[0] === c.name), [data?.schema]);
  const onFollowFk = useCallback(
    (d: number, col: number) => {
      const c = columns[col];
      const fk = fkFor(c);
      const v = valueAt(d, col);
      if (!fk || v == null) return;
      openObject(workspaceId, { schema: fk.refTable.schema, name: fk.refTable.name, kind: "table" }, { filters: [{ column: fk.refColumns[0], op: "eq", value: cellText(v, c.logical) }], newTab: true, pin: true });
    },
    [columns, fkFor, valueAt, openObject, workspaceId],
  );

  const onSort = (column: string, additive: boolean) => {
    if (!tab) return;
    const cur = tab.sort.find((s) => s.column === column);
    let next: Sort[];
    if (!cur) next = additive ? [...tab.sort, { column, dir: "asc" }] : [{ column, dir: "asc" }];
    else if (cur.dir === "asc") next = tab.sort.map((s) => (s.column === column ? { column, dir: "desc" } : s));
    else next = tab.sort.filter((s) => s.column !== column);
    updateTab<TableTab>(workspaceId, tabId, { sort: next, scrollTop: 0 });
  };

  const buildChangeSet = useCallback((): ChangeSet => {
    const c = changes ?? { updates: {}, inserts: [], deletes: {} };
    return {
      table: table ?? null,
      updates: Object.values(c.updates).map(({ pk, column, value }) => ({ pk, column, value })),
      inserts: c.inserts,
      deletes: Object.values(c.deletes),
    };
  }, [changes, table]);

  const save = useCallback(async () => {
    if (!tab || !nChanges || saving || !w) return;
    if (w.info.environment === "production") {
      const r = await confirm({
        title: `Save ${nChanges} change${nChanges === 1 ? "" : "s"} to ${w.info.connectionName}?`,
        message: "This is a production database.",
        buttons: [
          { label: "Cancel", value: "cancel", role: "cancel" },
          { label: "Save", value: "save", role: "default" },
        ],
      });
      if (r !== "save") return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const out = await invoke("changes_apply", { workspaceId, changes: buildChangeSet() });
      revertChanges(workspaceId, tabId);
      toast(`Saved ${out.rowsAffected} row${out.rowsAffected === 1 ? "" : "s"} · ${out.durationMs} ms`);
      await load(true);
    } catch (e) {
      setSaveError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }, [tab, nChanges, saving, w, workspaceId, buildChangeSet, revertChanges, tabId, load]);

  useBus("save", useCallback(() => void save(), [save]));
  useBus(
    "new-row",
    useCallback(() => {
      if (!editable) return toast("This table is read-only", "error");
      addInsert(workspaceId, tabId, {});
      updateTab<TableTab>(workspaceId, tabId, { selectedRow: 0 });
    }, [editable, addInsert, workspaceId, tabId, updateTab]),
  );
  useBus(
    "duplicate-row",
    useCallback(() => {
      if (!editable || tab?.selectedRow == null) return;
      const ref = refs[tab.selectedRow];
      if (!ref) return;
      const values: Record<string, Cell> = {};
      columns.forEach((c, i) => {
        if (!pk.includes(c.name)) values[c.name] = valueAt(tab.selectedRow!, i);
      });
      addInsert(workspaceId, tabId, values);
      updateTab<TableTab>(workspaceId, tabId, { selectedRow: 0 });
    }, [editable, tab?.selectedRow, refs, columns, pk, valueAt, addInsert, workspaceId, tabId, updateTab]),
  );

  // publish the selected row for the inspector
  const setSelection = useData((s) => s.setSelection);
  const selRow = tab?.selectedRow ?? null;
  useEffect(() => {
    if (selRow == null || selRow >= refs.length || !columns.length) {
      setSelection(tabId, null);
      return;
    }
    const ref = refs[selRow];
    setSelection(tabId, {
      columns,
      values: columns.map((_, i) => valueAt(selRow, i)),
      original: ref.kind === "row" ? rows[ref.i] : columns.map(() => null),
      editable,
      foreignKeys: data?.schema?.foreignKeys ?? [],
      onEdit: (col, value) => onEdit(selRow, col, value),
      onFollowFk: (col) => onFollowFk(selRow, col),
    });
  }, [selRow, refs, columns, valueAt, rows, editable, data?.schema?.foreignKeys, onEdit, onFollowFk, setSelection, tabId]);

  if (!tab || !w) return null;

  if (tab.view === "structure") {
    return <StructureView workspaceId={workspaceId} schema={data?.schema ?? null} loading={!data?.schema && !data?.error} error={data?.error ?? null} />;
  }

  const selected = tab.selectedRow;
  const vectorColumns = columns.filter(isVector);

  /**
   * Open a nearest-neighbour query for this row. The generated SQL references
   * the source row by key rather than pasting 1,536 literals, so it stays
   * readable — and stays correct when the row changes.
   */
  const findSimilar = (d: number, column: string, metric: (typeof METRICS)[number]["id"]) => {
    const keyColumn = pk[0];
    if (!keyColumn) return toast("This table has no primary key to anchor the search on.", "error");
    const keyIndex = columns.findIndex((c) => c.name === keyColumn);
    const keyValue = valueAt(d, keyIndex);
    if (keyValue == null) return toast("That row has no key value.", "error");
    const sql = similaritySql({
      table: tab.table,
      column,
      keyColumn,
      keyValue,
      metric,
      limit: 20,
      keyIsNumeric: isNumericType(columns[keyIndex]?.logical ?? "text"),
      selectColumns: columns.filter((c) => !isVector(c)).map((c) => c.name),
    });
    openQuery(workspaceId, sql, { title: `Similar to ${keyColumn} ${cellText(keyValue, columns[keyIndex]?.logical ?? "text")}`, autoRun: true });
  };

  const cellMenu = (d: number, col: number, e: React.MouseEvent) => {
    const ref = refs[d];
    const c = columns[col];
    if (!ref || !c) return;
    const v = valueAt(d, col);
    const fk = fkFor(c);
    const isDel = ref.kind === "row" && !!changes?.deletes[pkKey(pkOf(rows[ref.i]))];
    contextMenu(e, [
      { label: "Copy Cell", onSelect: () => void navigator.clipboard.writeText(cellText(v, c.logical)).then(() => toast("Copied")) },
      { label: "Copy Row as TSV", shortcut: chordLabel("Mod+Shift+C"), onSelect: () => void navigator.clipboard.writeText(columns.map((_, i) => cellText(valueAt(d, i), columns[i].logical)).join("\t")).then(() => toast("Copied row")) },
      { label: "Copy Row as JSON", onSelect: () => void navigator.clipboard.writeText(JSON.stringify(Object.fromEntries(columns.map((cc, i) => [cc.name, valueAt(d, i)])), null, 2)).then(() => toast("Copied row")) },
      { separator: true },
      // Nearest-neighbour search, without anyone having to remember `<=>`.
      ...(vectorColumns.length
        ? [
            {
              label: `Find similar rows by ${vectorColumns[0].name}`,
              disabled: !pk.length || ref.kind !== "row",
              // Cosine is what embeddings use; the other operators are written
              // into the generated SQL as a comment, one edit away.
              onSelect: () => findSimilar(d, vectorColumns[0].name, "cosine"),
            },
            { separator: true },
          ]
        : []),
      { label: fk ? `Open ${fk.refTable.name} where ${fk.refColumns[0]} = …` : "Follow Foreign Key", disabled: !fk || v == null, onSelect: () => onFollowFk(d, col) },
      { label: `Filter by ${c.name} = value`, disabled: v == null || typeof v === "object", onSelect: () => updateTab<TableTab>(workspaceId, tabId, { filters: [...tab.filters, { column: c.name, op: "eq", value: cellText(v, c.logical) }], showFilterBar: true }) },
      { separator: true },
      { label: "Edit Cell", shortcut: "⏎", disabled: !editable, onSelect: () => gridRef.current?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })) },
      { label: "Set NULL", disabled: !editable || c.nullable === false, onSelect: () => onEdit(d, col, null) },
      { label: "Revert Cell", disabled: !changeFor(ref, col), onSelect: () => ref.kind === "row" && setCellChange(workspaceId, tabId, pkOf(rows[ref.i]), c.name, rows[ref.i][col], rows[ref.i][col]) },
      { separator: true },
      { label: "Duplicate Row", shortcut: chordLabel("Mod+D"), disabled: !editable, onSelect: () => duplicateAt(d) },
      { label: ref.kind === "insert" ? "Discard New Row" : isDel ? "Undo Delete" : "Delete Row", shortcut: chordLabel("Mod+Backspace"), destructive: ref.kind !== "insert" && !isDel, disabled: !editable, onSelect: () => onDeleteRow(d) },
    ]);
  };
  const duplicateAt = (d: number) => {
    const values: Record<string, Cell> = {};
    columns.forEach((c, i) => {
      if (!pk.includes(c.name)) values[c.name] = valueAt(d, i);
    });
    addInsert(workspaceId, tabId, values);
    updateTab<TableTab>(workspaceId, tabId, { selectedRow: 0 });
  };

  const estimate = data?.exactCount ?? data?.schema?.rowEstimate ?? data?.result?.rowCount ?? null;

  return (
    <div className="grid-wrap" data-tab={tabId}>
      {readOnlyReason === "nopk" && (
        <div className="banner">
          <TriangleAlert /> No primary key — read only. Edits need a primary key to build a safe WHERE clause.
        </div>
      )}
      {readOnlyReason === "policy" && (
        <div className="banner">
          <Lock /> This connection is read-only.
          <button className="btn mini" onClick={() => { const c = w ? useConnections.getState().byId(w.info.connectionId) : undefined; if (c) setOverlay({ kind: "connection-sheet", profile: c, connectAfter: false }); }} title="Change the policy in the connection settings">
            Change…
          </button>
        </div>
      )}
      {readOnlyReason === "safe" && (
        <div className="banner">
          <Lock /> Safe mode — read only. Unlock in the toolbar ({chordLabel("Mod+Shift+L")}) to edit.
        </div>
      )}
      {readOnlyReason === "view" && (
        <div className="banner">
          <Lock /> Views are read only.
        </div>
      )}
      {tab.showFilterBar && <FilterBar columns={columns.length ? columns : (data?.schema?.columns.map((c) => ({ name: c.name, dataType: c.dataType, logical: c.logical, wire: "string" as const, nullable: c.nullable })) ?? [])} filters={tab.filters} onChange={(f) => updateTab<TableTab>(workspaceId, tabId, { filters: f, scrollTop: 0 })} onClose={() => updateTab<TableTab>(workspaceId, tabId, { showFilterBar: false })} />}
      {data?.error && !data.loading ? (
        <div className="empty error-text" style={{ margin: "auto" }}>
          {data.error}
          <small>
            <button className="btn plain" style={{ display: "inline", padding: 0, height: "auto" }} onClick={() => void load(true)}>
              Retry
            </button>
          </small>
        </div>
      ) : (
        <DataGrid
          gridRef={gridRef}
          columns={columns}
          rows={displayRows}
          exhausted={!cursor || cursor.exhausted}
          loading={!!data?.loading || !!cursor?.loading}
          onNeedMore={() => cursorId && void fetchMore(cursorId)}
          selectedRow={selected}
          onSelectRow={(i) => updateTab<TableTab>(workspaceId, tabId, { selectedRow: i })}
          valueAt={valueAt}
          isDirty={isDirty}
          rowClass={rowClass}
          editable={editable}
          onEdit={onEdit}
          onDeleteRow={editable ? onDeleteRow : undefined}
          onOpenJson={(row, col) => {
            const value = valueAt(row, col);
            const column = columns[col];
            if (value == null) return;
            const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
            openJson(workspaceId, text, {
              origin: `${tab?.title ?? "row"}.${column?.name ?? ""}`,
              sqlColumn: column?.name ?? null,
            });
          }}
          fkFor={fkFor}
          onFollowFk={onFollowFk}
          sort={tab.sort}
          onSort={onSort}
          hiddenColumns={tab.hiddenColumns}
          primaryKey={pk}
          initialScrollTop={tab.scrollTop}
          onScrollTop={(top) => updateTab<TableTab>(workspaceId, tabId, { scrollTop: top })}
          onContextMenu={cellMenu}
          emptyText={quick ? "No Matches" : tab.filters.length ? "No Rows" : "No Rows"}
          emptySub={quick ? `No loaded rows contain “${tab.quickFilter}”.` : tab.filters.length ? "No rows match the current filters." : "This table is empty."}
        />
      )}
      <div className="databar">
        <span>{selected != null ? `row ${selected + 1} of ${formatCount(displayRows.length)}` : `${formatCount(displayRows.length)} rows loaded${cursor && !cursor.exhausted ? " so far" : ""}${quick && filteredIdx ? ` · ${filteredIdx.length} match` : ""}`}</span>
        {data?.result?.truncated && limit != null && <span className="tertiary">· LIMIT {formatCount(limit)} applied</span>}
        <span className="r">
          <button className="mini" onClick={() => { if (!editable) return toast("This table is read-only", "error"); addInsert(workspaceId, tabId, {}); updateTab<TableTab>(workspaceId, tabId, { selectedRow: 0 }); }} title={`New row ${chordLabel("Mod+N")}`}>
            <Plus /> Row
          </button>
          <span style={{ position: "relative" }}>
            <button className="mini" onClick={() => setColumnsOpen((o) => !o)} aria-expanded={columnsOpen} aria-pressed={tab.hiddenColumns.length > 0}>
              <Columns3 /> Columns{tab.hiddenColumns.length ? ` (${columns.length - tab.hiddenColumns.length}/${columns.length})` : ""}
            </button>
            {columnsOpen && (
              <div ref={columnsRef} className="popover columns-pop" role="dialog" aria-label="Columns" style={{ position: "absolute" }}>
                <div className="h">
                  <span>Show columns</span>
                  <button className="btn plain" style={{ height: "auto", padding: 0, font: "var(--t-caption)" }} onClick={() => updateTab<TableTab>(workspaceId, tabId, { hiddenColumns: [] })}>
                    Show all
                  </button>
                </div>
                {columns.map((c) => (
                  <label key={c.name}>
                    <input
                      type="checkbox"
                      checked={!tab.hiddenColumns.includes(c.name)}
                      onChange={(e) => updateTab<TableTab>(workspaceId, tabId, { hiddenColumns: e.target.checked ? tab.hiddenColumns.filter((h) => h !== c.name) : [...tab.hiddenColumns, c.name] })}
                    />
                    <span className="truncate">{c.name}</span>
                    <span className="tertiary mono" style={{ marginLeft: "auto", fontSize: 10 }}>{c.dataType}</span>
                  </label>
                ))}
              </div>
            )}
          </span>
          <button className="mini" aria-pressed={tab.showFilterBar} onClick={() => updateTab<TableTab>(workspaceId, tabId, { showFilterBar: !tab.showFilterBar })} title={`Filters ${chordLabel("Mod+F")}`}>
            <Funnel /> Filters{tab.filters.length ? ` (${tab.filters.length})` : ""}
          </button>
          <span className="pager">
            <button aria-label="Scroll to top" onClick={() => { gridRef.current?.scrollTo({ top: 0 }); updateTab<TableTab>(workspaceId, tabId, { selectedRow: displayRows.length ? 0 : null }); }}>
              <ChevronLeft />
            </button>
            <button
              aria-label="Page size and options"
              onClick={(e) =>
                contextMenu(e, [
                  { label: "Limit: none", checked: limit == null, onSelect: () => setLimit(null) },
                  { label: "Limit: 100", checked: limit === 100, onSelect: () => setLimit(100) },
                  { label: "Limit: 1 000", checked: limit === 1000, onSelect: () => setLimit(1000) },
                  { label: "Limit: 10 000", checked: limit === 10000, onSelect: () => setLimit(10000) },
                  { separator: true },
                  { label: "Go to Row…", onSelect: () => void prompt("Go to row", "", "Row number").then((v) => { const n = Number(v); if (v && Number.isFinite(n) && n > 0) updateTab<TableTab>(workspaceId, tabId, { selectedRow: Math.min(displayRows.length - 1, n - 1) }); }) },
                  { label: `Row estimate: ${estimate != null ? `~${formatCount(estimate)}` : "unknown"}`, disabled: true },
                ])
              }
            >
              <Settings2 />
            </button>
            <button aria-label="Load more" disabled={!cursorId || cursor?.exhausted} onClick={() => { if (cursorId) void fetchMore(cursorId); gridRef.current?.scrollTo({ top: gridRef.current.scrollHeight }); }}>
              <ChevronRight />
            </button>
          </span>
        </span>
      </div>
      {nChanges > 0 && <SaveBar workspaceId={workspaceId} count={nChanges} changes={buildChangeSet} saving={saving} error={saveError} onRevert={() => revertChanges(workspaceId, tabId)} onSave={() => void save()} />}
    </div>
  );
}
