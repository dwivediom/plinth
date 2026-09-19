import { useState } from "react";
import { Plus, X } from "lucide-react";
import type { ColumnDesc, Filter, FilterOp } from "../../ipc/types";

const ops: { op: FilterOp; label: string; needsValue: boolean }[] = [
  { op: "eq", label: "=", needsValue: true },
  { op: "neq", label: "≠", needsValue: true },
  { op: "lt", label: "<", needsValue: true },
  { op: "lte", label: "≤", needsValue: true },
  { op: "gt", label: ">", needsValue: true },
  { op: "gte", label: "≥", needsValue: true },
  { op: "like", label: "LIKE", needsValue: true },
  { op: "not-like", label: "NOT LIKE", needsValue: true },
  { op: "in", label: "IN", needsValue: true },
  { op: "is-null", label: "IS NULL", needsValue: false },
  { op: "is-not-null", label: "IS NOT NULL", needsValue: false },
];
const opLabel = (op: FilterOp) => ops.find((o) => o.op === op)?.label ?? op;

export function FilterBar({ columns, filters, onChange, onClose }: { columns: ColumnDesc[]; filters: Filter[]; onChange: (f: Filter[]) => void; onClose: () => void }) {
  const [draft, setDraft] = useState<Filter | null>(filters.length ? null : { column: columns[0]?.name ?? "", op: "eq", value: "" });

  const add = () => {
    if (!draft || !draft.column) return;
    const needs = ops.find((o) => o.op === draft.op)?.needsValue;
    if (needs && !draft.value?.trim()) return;
    onChange([...filters, { ...draft, value: needs ? draft.value : null }]);
    setDraft(null);
  };

  return (
    <div className="filterbar" role="group" aria-label="Filters">
      {filters.map((f, i) => (
        <span key={i} className="chip" title="Server-side filter">
          {f.column} {opLabel(f.op)} {f.value != null ? (f.op === "in" ? `(${f.value})` : /^-?\d+(\.\d+)?$/.test(f.value) ? f.value : `'${f.value}'`) : ""}
          <button className="x" aria-label="Remove filter" onClick={() => onChange(filters.filter((_, j) => j !== i))}>
            <X />
          </button>
        </span>
      ))}
      {draft ? (
        <form
          className="editor"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <select className="native" value={draft.column} onChange={(e) => setDraft({ ...draft, column: e.target.value })} aria-label="Column">
            {columns.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
          <select className="native" value={draft.op} onChange={(e) => setDraft({ ...draft, op: e.target.value as FilterOp })} aria-label="Operator">
            {ops.map((o) => (
              <option key={o.op} value={o.op}>
                {o.label}
              </option>
            ))}
          </select>
          {ops.find((o) => o.op === draft.op)?.needsValue && (
            <div className="field mono">
              <input autoFocus value={draft.value ?? ""} placeholder={draft.op === "in" ? "a, b, c" : draft.op.includes("like") ? "%text%" : "value"} onChange={(e) => setDraft({ ...draft, value: e.target.value })} onKeyDown={(e) => e.key === "Escape" && setDraft(null)} aria-label="Value" />
            </div>
          )}
          <button type="submit" className="btn mini default">
            Apply
          </button>
          <button type="button" className="btn mini" onClick={() => setDraft(null)}>
            Cancel
          </button>
        </form>
      ) : (
        <button className="chip add" onClick={() => setDraft({ column: columns[0]?.name ?? "", op: "eq", value: "" })}>
          <Plus style={{ width: 11, height: 11 }} /> Filter
        </button>
      )}
      <button className="btn mini" onClick={onClose} title="Hide filter bar (⌘F)">
        Done
      </button>
    </div>
  );
}
