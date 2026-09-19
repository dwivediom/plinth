import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Check, X } from "lucide-react";
import { useConfirm, useMenu, usePrompt, useToasts, type MenuItem } from "../../state/overlays";

/** Right-click context menu, positioned within the viewport. */
export function ContextMenu() {
  const open = useMenu((s) => s.open);
  const hide = useMenu((s) => s.hide);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const x = Math.min(open.x, window.innerWidth - r.width - 8);
    const y = Math.min(open.y, window.innerHeight - r.height - 8);
    setPos({ x: Math.max(4, x), y: Math.max(4, y) });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) hide();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        hide();
      }
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", hide);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", hide);
    };
  }, [open, hide]);

  if (!open) return null;
  return (
    <div ref={ref} className="menu" role="menu" style={{ left: pos?.x ?? open.x, top: pos?.y ?? open.y, visibility: pos ? "visible" : "hidden" }} onContextMenu={(e) => e.preventDefault()}>
      {open.items.map((it, i) => (
        <MenuRow key={i} item={it} onDone={hide} />
      ))}
    </div>
  );
}

function MenuRow({ item, onDone }: { item: MenuItem; onDone: () => void }) {
  if (item.separator) return <hr />;
  return (
    <button
      role="menuitem"
      className={`item${item.destructive ? " destructive" : ""}`}
      disabled={item.disabled}
      onClick={() => {
        onDone();
        item.onSelect?.();
      }}
    >
      {item.checked !== undefined && <span className="check">{item.checked ? <Check /> : null}</span>}
      <span>{item.label}</span>
      {item.shortcut && <span className="kbd">{item.shortcut}</span>}
    </button>
  );
}

/** A macOS-style sheet with a scrim. Esc closes. */
export function Sheet({ children, onClose, width, className }: { children: ReactNode; onClose: () => void; width?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    // focus the first focusable
    const first = ref.current?.querySelector<HTMLElement>("input, select, textarea, button");
    first?.focus();
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return (
    <>
      <div className="scrim" onMouseDown={onClose} />
      <div ref={ref} className={`sheet${className ? " " + className : ""}`} role="dialog" aria-modal="true" style={width ? { width } : undefined}>
        {children}
      </div>
    </>
  );
}

export function ConfirmDialog() {
  const current = useConfirm((s) => s.current);
  const answer = useConfirm((s) => s.answer);
  if (!current) return null;
  const cancel = current.buttons.find((b) => b.role === "cancel");
  return (
    <Sheet onClose={() => answer(cancel?.value ?? current.buttons[0].value)} width={420}>
      <h2>{current.title}</h2>
      {current.message && <div className="secondary" style={{ lineHeight: "18px" }}>{current.message}</div>}
      <div className="actions">
        {current.buttons.map((b) => (
          <button key={b.value} className={`btn${b.role === "default" ? " default" : ""}${b.role === "destructive" ? " danger" : ""}`} onClick={() => answer(b.value)} autoFocus={b.role === "default"}>
            {b.label}
          </button>
        ))}
      </div>
    </Sheet>
  );
}

export function PromptDialog() {
  const current = usePrompt((s) => s.current);
  const answer = usePrompt((s) => s.answer);
  const [value, setValue] = useState("");
  useEffect(() => setValue(current?.initial ?? ""), [current]);
  if (!current) return null;
  return (
    <Sheet onClose={() => answer(null)} width={420}>
      <h2>{current.title}</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          answer(value.trim() || null);
        }}
        style={{ display: "contents" }}
      >
        <div className="field">
          <input autoFocus value={value} placeholder={current.placeholder} onChange={(e) => setValue(e.target.value)} onFocus={(e) => e.target.select()} />
        </div>
        <div className="actions">
          <button type="button" className="btn" onClick={() => answer(null)}>
            Cancel
          </button>
          <button type="submit" className="btn default" disabled={!value.trim()}>
            OK
          </button>
        </div>
      </form>
    </Sheet>
  );
}

export function Toasts() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);
  if (!toasts.length) return null;
  return (
    <div className="toasts" role="status">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <span className="selectable">{t.text}</span>
          {t.action && (
            <button
              className="btn mini act"
              onClick={() => {
                dismiss(t.id);
                t.action?.run();
              }}
            >
              {t.action.label}
            </button>
          )}
          <button onClick={() => dismiss(t.id)} aria-label="Dismiss">
            <X />
          </button>
        </div>
      ))}
    </div>
  );
}

/** Click-outside + Esc for popovers. */
export function usePopoverDismiss(open: boolean, onClose: () => void, ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open, onClose, ref]);
}

export function Segmented<T extends string>({ value, options, onChange, small, fill, ariaLabel }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; small?: boolean; fill?: boolean; ariaLabel?: string }) {
  return (
    <div className={`seg${small ? " small" : ""}${fill ? " fill" : ""}`} role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => (
        <button key={o.value} role="radio" className="segment" aria-pressed={o.value === value} aria-checked={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
