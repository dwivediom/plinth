import { useEffect, useRef, useState } from "react";
import type { Cell, ColumnDesc } from "../../ipc/types";
import { isNumericType } from "../../ipc/types";
import { cellEditText, parseCellInput } from "../../lib/format";

interface Props {
  column: ColumnDesc;
  value: Cell;
  onCommit: (v: Cell) => void;
  onCancel: () => void;
}

/** Per-type inline editor: checkbox for bool, textarea popover for json, input otherwise. */
export function CellEditor({ column, value, onCommit, onCancel }: Props) {
  const [text, setText] = useState(() => cellEditText(value, column.logical));
  const [error, setError] = useState<string | null>(null);
  const [isNull, setIsNull] = useState(value == null);
  const ref = useRef<HTMLInputElement | HTMLTextAreaElement>(null);

  useEffect(() => {
    ref.current?.focus();
    if (ref.current instanceof HTMLInputElement) ref.current.select();
  }, []);

  const commit = () => {
    if (isNull) return onCommit(null);
    const r = parseCellInput(text, column);
    if (!r.ok) return setError(r.error);
    onCommit(r.value);
  };

  if (column.wire === "bool") {
    return (
      <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }} onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={ref as React.RefObject<HTMLInputElement>}
          type="checkbox"
          checked={value === true}
          onChange={(e) => onCommit(e.target.checked)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onCancel();
            if (e.key === "Enter") onCommit(!(value === true));
          }}
          onBlur={onCancel}
        />
        {column.nullable !== false && (
          <button className="btn mini" onMouseDown={(e) => e.preventDefault()} onClick={() => onCommit(null)}>
            NULL
          </button>
        )}
      </span>
    );
  }

  if (column.wire === "json" || column.logical === "json") {
    return (
      <div className="cell-edit-pop" onMouseDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
        <textarea
          ref={ref as React.RefObject<HTMLTextAreaElement>}
          className="plain"
          value={text}
          spellCheck={false}
          onChange={(e) => {
            setText(e.target.value);
            setIsNull(false);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") onCancel();
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) commit();
          }}
        />
        {error && <span className="err">{error}</span>}
        <div className="actions">
          {column.nullable !== false && (
            <button className="btn mini" onClick={() => onCommit(null)}>
              Set NULL
            </button>
          )}
          <span className="spacer" />
          <button className="btn mini" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn mini default" onClick={commit}>
            Save ⌘⏎
          </button>
        </div>
      </div>
    );
  }

  return (
    <input
      ref={ref as React.RefObject<HTMLInputElement>}
      className={`ed${isNumericType(column.logical) ? " num" : ""}`}
      value={isNull ? "" : text}
      placeholder={isNull ? "NULL" : undefined}
      aria-invalid={!!error}
      title={error ?? undefined}
      style={error ? { boxShadow: "0 0 0 1.5px var(--red)" } : undefined}
      onChange={(e) => {
        setText(e.target.value);
        setIsNull(false);
        setError(null);
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        } else if (e.key === "Backspace" && (e.metaKey || e.ctrlKey) && column.nullable !== false) {
          e.preventDefault();
          onCommit(null);
        } else if (e.key === "Tab") {
          e.preventDefault();
          commit();
        }
      }}
      onBlur={() => {
        // commit on blur unless invalid
        if (isNull) return onCommit(null);
        const r = parseCellInput(text, column);
        if (r.ok) onCommit(r.value);
        else onCancel();
      }}
    />
  );
}
