import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, KeyRound , Braces } from "lucide-react";
import type { Cell, ColumnDesc, ForeignKey, LogicalType, Sort } from "../../ipc/types";
import { isNumericType } from "../../ipc/types";
import { isVector, parseVector, sparkline } from "../../lib/vector";
import { cellText } from "../../lib/format";
import { isMod } from "../../lib/keys";
import { toast } from "../../state/overlays";
import { CellEditor } from "./CellEditor";

export const ROW_H = 26;

export interface GridProps {
  columns: ColumnDesc[];
  rows: Cell[][];
  /** false while more windows can be fetched */
  exhausted: boolean;
  loading: boolean;
  onNeedMore?: () => void;
  selectedRow: number | null;
  onSelectRow: (i: number | null) => void;
  /** Override displayed value (dirty edits). */
  valueAt?: (row: number, col: number) => Cell;
  isDirty?: (row: number, col: number) => boolean;
  rowClass?: (row: number) => string;
  editable?: boolean;
  onEdit?: (row: number, col: number, value: Cell) => void;
  fkFor?: (col: ColumnDesc) => ForeignKey | undefined;
  onFollowFk?: (row: number, col: number) => void;
  sort?: Sort[];
  onSort?: (column: string, additive: boolean) => void;
  hiddenColumns?: string[];
  primaryKey?: string[];
  initialScrollTop?: number;
  onScrollTop?: (top: number) => void;
  onContextMenu?: (row: number, col: number, e: ReactMouseEvent) => void;
  onDeleteRow?: (row: number) => void;
  /** Open a JSON cell in the viewer. Without it, the glyph is not drawn. */
  onOpenJson?: (row: number, col: number) => void;
  emptyText?: string;
  emptySub?: string;
  /** exposes focus to parents */
  gridRef?: React.RefObject<HTMLDivElement | null>;
}

function defaultWidth(c: ColumnDesc): number {
  const l: LogicalType = c.logical;
  if (l === "bool") return 76;
  if (l === "uuid") return 290;
  if (l === "timestamp") return 190;
  if (l === "date") return 110;
  if (l === "json" || l === "array" || l === "document") return 220;
  // Sparkline + dimensions + norm, with room to read all three.
  if (l === "vector") return 168;
  if (isNumericType(l)) return c.name.endsWith("id") || c.name === "id" ? 150 : 120;
  return Math.max(120, Math.min(260, 40 + c.name.length * 8));
}

const kindClass = (c: ColumnDesc) => (isNumericType(c.logical) ? "num" : c.logical === "bool" ? "bool" : c.logical === "json" ? "json" : "");

export function DataGrid(p: GridProps) {
  const { columns, rows, exhausted, loading, onNeedMore, selectedRow, onSelectRow, valueAt, isDirty, rowClass, editable, onEdit, fkFor, onFollowFk, sort, onSort, hiddenColumns, primaryKey, initialScrollTop, onScrollTop, onContextMenu, onDeleteRow, onOpenJson } = p;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [focusCol, setFocusCol] = useState(0);
  const [editing, setEditing] = useState<{ row: number; col: number } | null>(null);
  const restored = useRef(false);

  const visible = useMemo(() => columns.map((c, i) => ({ c, i })).filter(({ c }) => !hiddenColumns?.includes(c.name)), [columns, hiddenColumns]);
  const widthOf = useCallback((c: ColumnDesc) => widths[c.name] ?? defaultWidth(c), [widths]);
  const totalWidth = visible.reduce((a, { c }) => a + widthOf(c), 0);

  const count = rows.length + (exhausted ? 0 : 1);
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 12,
  });
  const items = virtualizer.getVirtualItems();

  // fetch the next window as the viewport nears the end
  useEffect(() => {
    if (exhausted || loading || !onNeedMore) return;
    const last = items[items.length - 1];
    if (last && last.index >= rows.length - 40) onNeedMore();
  }, [items, rows.length, exhausted, loading, onNeedMore]);

  // restore scroll once rows exist
  useLayoutEffect(() => {
    if (restored.current || !initialScrollTop || !scrollRef.current || !rows.length) return;
    scrollRef.current.scrollTop = initialScrollTop;
    restored.current = true;
  }, [initialScrollTop, rows.length]);

  const scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onScroll = () => {
    if (!onScrollTop) return;
    if (scrollTimer.current) clearTimeout(scrollTimer.current);
    scrollTimer.current = setTimeout(() => onScrollTop(scrollRef.current?.scrollTop ?? 0), 200);
  };

  useEffect(() => {
    if (selectedRow != null && selectedRow < count) virtualizer.scrollToIndex(selectedRow, { align: "auto" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRow]);

  const startEdit = useCallback(
    (row: number, colVisibleIndex: number) => {
      if (!editable || row >= rows.length) return;
      const col = visible[colVisibleIndex];
      if (!col) return;
      setEditing({ row, col: col.i });
    },
    [editable, rows.length, visible],
  );

  const copy = (row: number, wholeRow: boolean) => {
    if (row >= rows.length) return;
    const get = (ci: number) => cellText(valueAt ? valueAt(row, ci) : rows[row][ci], columns[ci].logical);
    const text = wholeRow ? visible.map(({ i }) => get(i)).join("\t") : get(visible[focusCol]?.i ?? 0);
    void navigator.clipboard.writeText(text).then(() => toast(wholeRow ? "Copied row" : "Copied cell"));
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (editing) return;
    const max = rows.length - 1;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      onSelectRow(Math.min(max, (selectedRow ?? -1) + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      onSelectRow(Math.max(0, (selectedRow ?? 1) - 1));
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      setFocusCol((c) => Math.min(visible.length - 1, c + 1));
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      setFocusCol((c) => Math.max(0, c - 1));
    } else if (e.key === "Home") {
      e.preventDefault();
      onSelectRow(0);
    } else if (e.key === "End") {
      e.preventDefault();
      onSelectRow(max);
    } else if (e.key === "PageDown" || e.key === "PageUp") {
      e.preventDefault();
      const page = Math.floor((scrollRef.current?.clientHeight ?? 400) / ROW_H) - 1;
      onSelectRow(Math.max(0, Math.min(max, (selectedRow ?? 0) + (e.key === "PageDown" ? page : -page))));
    } else if (e.key === "Enter" || e.key === "F2") {
      if (selectedRow != null) {
        e.preventDefault();
        startEdit(selectedRow, focusCol);
      }
    } else if (e.key === "Escape") {
      onSelectRow(null);
    } else if ((e.key === "c" || e.key === "C") && isMod(e)) {
      if (selectedRow != null) {
        e.preventDefault();
        copy(selectedRow, e.shiftKey);
      }
    } else if (e.key === "Backspace" && isMod(e)) {
      if (selectedRow != null && onDeleteRow) {
        e.preventDefault();
        onDeleteRow(selectedRow);
      }
    } else if (e.key === " ") {
      // toggle booleans with space
      const col = visible[focusCol];
      if (selectedRow != null && col && col.c.logical === "bool" && editable && onEdit) {
        e.preventDefault();
        const v = valueAt ? valueAt(selectedRow, col.i) : rows[selectedRow][col.i];
        onEdit(selectedRow, col.i, !v);
      }
    }
  };

  const startResize = (e: ReactMouseEvent, c: ColumnDesc) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = widthOf(c);
    const move = (ev: MouseEvent) => setWidths((w) => ({ ...w, [c.name]: Math.max(48, startW + ev.clientX - startX) }));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const sortFor = (name: string) => sort?.find((s) => s.column === name);
  const gridEl = (
    <div
      ref={(el) => {
        (scrollRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
        if (p.gridRef) (p.gridRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
      }}
      className="grid"
      role="grid"
      aria-rowcount={rows.length}
      aria-colcount={visible.length}
      aria-multiselectable={false}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onScroll={onScroll}
    >
      <div className="hdr" role="row" style={{ width: totalWidth, minWidth: "100%" }}>
        {visible.map(({ c }, vi) => {
          const s = sortFor(c.name);
          const isPk = primaryKey?.includes(c.name);
          return (
            <div
              key={c.name}
              role="columnheader"
              aria-sort={s ? (s.dir === "asc" ? "ascending" : "descending") : "none"}
              className={`th ${kindClass(c)}`}
              style={{ width: widthOf(c) }}
              onClick={(e) => onSort?.(c.name, e.shiftKey)}
              onDoubleClick={() => setFocusCol(vi)}
              title={`${c.name} · ${c.dataType}${c.nullable === false ? " · not null" : ""}`}
            >
              <span className="nm">
                {isPk && (
                  <span className="pk" title="Primary key">
                    <KeyRound />
                  </span>
                )}
                <span className="truncate">{c.name}</span>
                {s && <span className="sort">{s.dir === "asc" ? <ArrowUp /> : <ArrowDown />}</span>}
              </span>
              <span className="ty">{c.dataType}</span>
              <span className="rs" onMouseDown={(e) => startResize(e, c)} onClick={(e) => e.stopPropagation()} />
            </div>
          );
        })}
      </div>
      <div className="body" style={{ height: virtualizer.getTotalSize(), width: totalWidth, minWidth: "100%" }}>
        {items.map((vi) => {
          const r = vi.index;
          if (r >= rows.length) {
            return (
              <div key="loading" className="row loading" role="row" style={{ transform: `translateY(${vi.start}px)`, width: totalWidth, minWidth: "100%" }}>
                <div className="cell" style={{ width: 200 }}>
                  {loading ? "Loading…" : ""}
                </div>
              </div>
            );
          }
          const selected = selectedRow === r;
          const extra = rowClass?.(r) ?? "";
          return (
            <div
              key={r}
              className={`row${r % 2 ? " odd" : ""}${extra ? " " + extra : ""}`}
              role="row"
              aria-rowindex={r + 1}
              aria-selected={selected}
              style={{ transform: `translateY(${vi.start}px)`, width: totalWidth, minWidth: "100%" }}
              onMouseDown={(e) => {
                if (e.button !== 0) return;
                onSelectRow(r);
              }}
              onContextMenu={(e) => {
                onSelectRow(r);
                const cellEl = (e.target as HTMLElement).closest<HTMLElement>("[data-col]");
                const col = cellEl ? Number(cellEl.dataset.col) : visible[focusCol]?.i ?? 0;
                onContextMenu?.(r, col, e);
              }}
            >
              {visible.map(({ c, i }, colVi) => {
                const v = valueAt ? valueAt(r, i) : rows[r][i];
                const dirty = isDirty?.(r, i);
                const isEditing = editing?.row === r && editing.col === i;
                const fk = fkFor?.(c);
                const cls = `cell ${kindClass(c)}${dirty ? " dirty" : ""}${selected && colVi === focusCol ? " focus" : ""}`;
                return (
                  <div
                    key={c.name}
                    role="gridcell"
                    data-col={i}
                    className={cls}
                    style={{ width: widthOf(c) }}
                    onMouseDown={() => setFocusCol(colVi)}
                    onDoubleClick={() => startEdit(r, colVi)}
                    title={isEditing ? undefined : cellText(v, c.logical)}
                  >
                    {isEditing ? (
                      <CellEditor
                        column={c}
                        value={v}
                        onCommit={(nv) => {
                          setEditing(null);
                          onEdit?.(r, i, nv);
                          scrollRef.current?.focus();
                        }}
                        onCancel={() => {
                          setEditing(null);
                          scrollRef.current?.focus();
                        }}
                      />
                    ) : (
                      <CellValue value={v} column={c} fk={!!fk && v != null} onFollow={fk ? () => onFollowFk?.(r, i) : undefined} onOpenJson={onOpenJson ? () => onOpenJson(r, i) : undefined} />
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      {!rows.length && !loading && exhausted && (
        <div className="grid-empty">
          <div className="empty">
            {p.emptyText ?? "No Rows"}
            <small>{p.emptySub ?? "This table is empty."}</small>
          </div>
        </div>
      )}
    </div>
  );
  return gridEl;
}

function CellValue({ value, column, fk, onFollow, onOpenJson }: { value: Cell; column: ColumnDesc; fk: boolean; onFollow?: () => void; onOpenJson?: () => void }) {
  if (value == null) return <span className="null">NULL</span>;
  // An embedding is 20 KB of digits. Show its shape, not its contents.
  if (isVector(column)) return <VectorCell value={value} />;
  const text = cellText(value, column.logical);
  // A JSON cell is a document squeezed onto one line. The glyph is the way
  // out of that — it appears on hover so the column stays readable.
  if (column.logical === "json" && onOpenJson) {
    return (
      <>
        <span className="truncate">{text}</span>
        <button
          className="jopen"
          title="Open in the JSON viewer"
          aria-label="Open in the JSON viewer"
          onClick={(e) => {
            e.stopPropagation();
            onOpenJson();
          }}
          onDoubleClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <Braces />
        </button>
      </>
    );
  }
  if (fk && onFollow) {
    return (
      <span
        className="fk"
        role="link"
        onClick={(e) => {
          e.stopPropagation();
          onFollow();
        }}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        {text}
      </span>
    );
  }
  return <>{text}</>;
}

/** `1536d · ‖v‖ 1.00` and a fingerprint, in one row's height. */
function VectorCell({ value }: { value: Cell }) {
  const stats = parseVector(value);
  if (!stats) return <span className="null">{cellText(value, "text")}</span>;
  return (
    <span className="vec" title={`${stats.dims} dimensions · norm ${stats.norm.toFixed(3)} · min ${stats.min.toFixed(3)} · max ${stats.max.toFixed(3)}`}>
      <svg width={54} height={14} viewBox="0 0 54 14" aria-hidden>
        <path d={sparkline(stats.values, 54, 14)} fill="none" stroke="var(--series-1)" strokeWidth={1} />
      </svg>
      <em>{stats.dims}d</em>
      <b>‖v‖ {stats.norm.toFixed(2)}</b>
    </span>
  );
}
