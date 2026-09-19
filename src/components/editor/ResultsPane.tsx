import { useCallback, useEffect } from "react";
import { DataGrid } from "../../components/grid/DataGrid";
import { cellText, formatCount } from "../../lib/format";
import { useData } from "../../state/data";
import { contextMenu, toast } from "../../state/overlays";
import type { QueryTab } from "../../state/types";
import { useWorkspaces } from "../../state/workspaces";

export function ResultsPane({ workspaceId, tabId }: { workspaceId: string; tabId: string }) {
  const run = useData((s) => s.queries[tabId]);
  const setQuery = useData((s) => s.setQuery);
  const fetchMore = useData((s) => s.fetchMore);
  const tab = useWorkspaces((s) => s.byId[workspaceId]?.tabs.find((t) => t.id === tabId)) as QueryTab | undefined;
  const updateTab = useWorkspaces((s) => s.updateTab);
  const openQuery = useWorkspaces((s) => s.openQuery);
  const active = run?.results[run.active];
  const cursorId = active?.cursorId ?? null;
  const cursor = useData((s) => (cursorId ? s.cursors[cursorId] : undefined));
  const onNeedMore = useCallback(() => cursorId && void fetchMore(cursorId), [cursorId, fetchMore]);
  const setSelection = useData((s) => s.setSelection);
  const selRow = tab?.selectedRow ?? null;
  useEffect(() => {
    const row = selRow != null ? cursor?.rows[selRow] : undefined;
    if (!active || !row) {
      setSelection(tabId, null);
      return;
    }
    setSelection(tabId, { columns: active.columns, values: row, original: row, editable: false, foreignKeys: [] });
  }, [selRow, cursor?.rows, active, setSelection, tabId]);

  if (!run || (!run.results.length && !run.running)) {
    return (
      <div className="empty" style={{ margin: "auto" }}>
        No Results
        <small>Run a statement with ⌘⏎ to see rows here.</small>
      </div>
    );
  }
  if (run.running) return <div className="empty" style={{ margin: "auto" }} />;

  return (
    <>
      {run.results.length > 1 && (
        <div className="result-tabs" role="tablist" aria-label="Result sets">
          {run.results.map((r, i) => (
            <button key={i} role="tab" aria-selected={i === run.active} onClick={() => setQuery(tabId, { active: i })} title={r.statement}>
              {r.error ? <span className="e">error</span> : r.kind === "select" ? `Result ${i + 1}` : r.kind}
              <span className="k">{r.error ? "" : r.rowCount != null ? formatCount(r.rowCount) : r.rowsAffected != null ? `${r.rowsAffected} affected` : ""}</span>
            </button>
          ))}
        </div>
      )}
      {active && !active.error && active.kind !== "select" && active.cursorId == null ? (
        <div className="affected">
          <b>{formatCount(active.rowsAffected ?? 0)}</b> row{active.rowsAffected === 1 ? "" : "s"} affected · {active.durationMs} ms
          <div className="tertiary mono" style={{ marginTop: 8, font: "var(--t-mono)", fontSize: 11 }}>{active.statement}</div>
        </div>
      ) : active && !active.error ? (
        <DataGrid
          columns={active.columns}
          rows={cursor?.rows ?? []}
          exhausted={!cursor || cursor.exhausted}
          loading={!!cursor?.loading}
          onNeedMore={onNeedMore}
          selectedRow={tab?.selectedRow ?? null}
          onSelectRow={(i) => updateTab<QueryTab>(workspaceId, tabId, { selectedRow: i })}
          editable={false}
          emptyText="No Rows"
          emptySub="The statement returned no rows."
          onContextMenu={(r, c, e) => {
            const rows = cursor?.rows ?? [];
            const col = active.columns[c];
            contextMenu(e, [
              { label: "Copy Cell", onSelect: () => void navigator.clipboard.writeText(cellText(rows[r]?.[c] ?? null, col?.logical)).then(() => toast("Copied")) },
              { label: "Copy Row as TSV", onSelect: () => void navigator.clipboard.writeText((rows[r] ?? []).map((v, i) => cellText(v, active.columns[i].logical)).join("\t")).then(() => toast("Copied row")) },
              { label: "Copy Row as JSON", onSelect: () => void navigator.clipboard.writeText(JSON.stringify(Object.fromEntries(active.columns.map((cc, i) => [cc.name, rows[r]?.[i] ?? null])), null, 2)).then(() => toast("Copied row")) },
              { separator: true },
              { label: "Open Statement in New Tab", onSelect: () => openQuery(workspaceId, active.statement) },
            ]);
          }}
        />
      ) : null}
    </>
  );
}
