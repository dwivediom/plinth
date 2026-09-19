import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, ChevronRight, FileCode, GitCompare, Minus, Pencil, Plus, RotateCw } from "lucide-react";
import { errorMessage, invoke } from "../../ipc/client";
import type { ColumnDiff, DiffStatus, SchemaDiff, TableDiff } from "../../ipc/types";
import { toast } from "../../state/overlays";
import type { DiffTab } from "../../state/types";
import { useWorkspaces } from "../../state/workspaces";

/** Added / removed / changed, in the colours people already expect from a diff. */
const MARK: Record<DiffStatus, { icon: React.ReactNode; className: string; label: string }> = {
  added: { icon: <Plus />, className: "added", label: "only here" },
  removed: { icon: <Minus />, className: "removed", label: "only there" },
  changed: { icon: <Pencil />, className: "changed", label: "differs" },
  same: { icon: null, className: "same", label: "same" },
};

function columnDetail(c: ColumnDiff): string {
  const shape = (s: typeof c.left) => (s ? `${s.dataType}${s.nullable ? "" : " NOT NULL"}${s.default ? ` DEFAULT ${s.default}` : ""}` : "—");
  if (c.status === "changed") return `${shape(c.right)}  →  ${shape(c.left)}`;
  return shape(c.left ?? c.right);
}

export function DiffView({ workspaceId, tabId }: { workspaceId: string; tabId: string }) {
  const tab = useWorkspaces((s) => s.byId[workspaceId]?.tabs.find((t) => t.id === tabId)) as DiffTab | undefined;
  const updateTab = useWorkspaces((s) => s.updateTab);
  const openQuery = useWorkspaces((s) => s.openQuery);
  const setActive = useWorkspaces((s) => s.setActive);
  // Select the raw slices, then derive: a selector that builds a new array
  // every call makes zustand's snapshot change identity on every render, and
  // React loops until it gives up.
  const order = useWorkspaces((s) => s.order);
  const byId = useWorkspaces((s) => s.byId);
  const [diff, setDiff] = useState<SchemaDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [showSame, setShowSame] = useState(false);

  const others = useMemo(() => order.map((id) => byId[id]).filter((w) => w && w.info.id !== workspaceId), [order, byId, workspaceId]);
  const right = tab?.rightWorkspaceId ?? null;

  const run = useCallback(async () => {
    if (!right) return;
    setLoading(true);
    setError(null);
    try {
      setDiff(await invoke("schema_diff", { leftWorkspaceId: workspaceId, rightWorkspaceId: right }));
    } catch (e) {
      setError(errorMessage(e));
      setDiff(null);
    } finally {
      setLoading(false);
    }
  }, [workspaceId, right]);

  useEffect(() => {
    void run();
  }, [run]);

  const tables = useMemo(() => (diff ? diff.tables.filter((t) => showSame || t.status !== "same") : []), [diff, showSame]);
  const sameCount = diff ? diff.tables.filter((t) => t.status === "same").length : 0;

  const generate = async () => {
    if (!diff) return;
    try {
      const sql = await invoke("migration_sql", { workspaceId, diff });
      // The migration runs against the *target*, so it opens there — and we
      // follow it, otherwise pressing the button looks like it did nothing.
      // Never auto-run: DDL is meant to be read first.
      const target = right ?? workspaceId;
      openQuery(target, sql, { title: `Migration · ${diff.rightLabel}` });
      if (target !== workspaceId) setActive(target);
      toast(`Migration opened against ${diff.rightLabel} — read it, then run it there`);
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  if (!tab) return null;

  return (
    <div className="diffview">
      <div className="diffbar">
        <GitCompare />
        <span className="side">{diff?.leftLabel ?? "this database"}</span>
        <ArrowRight />
        <select
          className="native"
          value={right ?? ""}
          onChange={(e) => updateTab<DiffTab>(workspaceId, tabId, { rightWorkspaceId: e.target.value || null })}
        >
          <option value="">Compare with…</option>
          {others.map((w) => (
            <option key={w.info.id} value={w.info.id}>
              {w.info.connectionName} · {w.info.database}
            </option>
          ))}
        </select>
        <span className="spacer" />
        {diff && (
          <span className="counts">
            <b className="added">+{diff.summary.tablesAdded + diff.summary.columnsAdded}</b>
            <b className="removed">−{diff.summary.tablesRemoved + diff.summary.columnsRemoved}</b>
            <b className="changed">~{diff.summary.tablesChanged + diff.summary.columnsChanged}</b>
          </span>
        )}
        <button className="icon-btn" title="Re-read both schemas" onClick={() => void run()} disabled={!right || loading}>
          <RotateCw />
        </button>
        <button className="btn default" onClick={() => void generate()} disabled={!diff || !tables.length}>
          <FileCode /> Generate Migration
        </button>
      </div>

      {error && <div className="errrow">{error}</div>}

      <div className="diffbody">
        {!right && (
          <div className="empty" style={{ margin: "auto" }}>
            Pick a database to compare with
            <small>{others.length ? "Both sides must be open — use ⌘⇧K to open another connection." : "Open a second connection first (⌘⇧K), then come back."}</small>
          </div>
        )}
        {right && loading && !diff && <div className="empty" style={{ margin: "auto" }}>Reading both schemas…</div>}
        {diff && !tables.length && (
          <div className="empty" style={{ margin: "auto" }}>
            No differences
            <small>{sameCount} tables match on both sides.</small>
          </div>
        )}
        {tables.map((t) => (
          <TableRow key={`${t.table.schema ?? ""}.${t.table.name}`} diff={t} open={!!open[t.table.name]} onToggle={() => setOpen((o) => ({ ...o, [t.table.name]: !o[t.table.name] }))} />
        ))}
        {diff && sameCount > 0 && (
          <button className="lnk showsame" onClick={() => setShowSame((v) => !v)}>
            {showSame ? "Hide" : "Show"} {sameCount} matching {sameCount === 1 ? "table" : "tables"}
          </button>
        )}
      </div>
    </div>
  );
}

function TableRow({ diff, open, onToggle }: { diff: TableDiff; open: boolean; onToggle: () => void }) {
  const mark = MARK[diff.status];
  const interesting = diff.columns.filter((c) => c.status !== "same");
  const shown = open ? diff.columns : interesting;
  return (
    <div className={`dtable ${mark.className}`}>
      <button className="head" onClick={onToggle} aria-expanded={open}>
        <ChevronRight className={open ? "twist open" : "twist"} />
        <span className="i">{mark.icon}</span>
        <span className="n">
          {diff.table.schema ? `${diff.table.schema}.` : ""}
          {diff.table.name}
        </span>
        {diff.kind !== "table" && <em>{diff.kind}</em>}
        <span className="s">{diff.status === "changed" ? `${interesting.length} column${interesting.length === 1 ? "" : "s"} differ` : mark.label}</span>
        {diff.primaryKeyChanged && <span className="warn">primary key differs</span>}
      </button>
      {!!shown.length && (
        <div className="cols">
          {shown.map((c) => (
            <div className={`dcol ${MARK[c.status].className}`} key={c.name}>
              <span className="i">{MARK[c.status].icon}</span>
              <span className="n">{c.name}</span>
              <span className="d">{columnDetail(c)}</span>
              {!!c.changes.length && <span className="w">{c.changes.join(", ")}</span>}
            </div>
          ))}
          {diff.indexes
            .filter((i) => i.status !== "same")
            .map((i) => (
              <div className={`dcol ${MARK[i.status].className}`} key={`idx-${i.name}`}>
                <span className="i">{MARK[i.status].icon}</span>
                <span className="n">index {i.name}</span>
                <span className="d">{(i.left ?? i.right)?.definition}</span>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
