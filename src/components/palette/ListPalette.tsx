import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Search } from "lucide-react";
import { compareMatches, fuzzyMatch, highlightChunks } from "../../lib/fuzzy";
import { useUi } from "../../state/ui";

export interface PaletteItem {
  id: string;
  group?: string;
  icon?: ReactNode;
  label: string;
  /** secondary text, shown dimmed */
  detail?: string;
  kbd?: string;
  /** extra text to match against */
  keywords?: string;
  onSelect: (mods: { alt: boolean; mod: boolean; shift: boolean }) => void;
}

interface Props {
  placeholder: string;
  items: PaletteItem[];
  hint?: ReactNode;
  /** Render as an anchored popover with an arrow rather than a centred palette. */
  anchor?: { left: number; top: number; width?: number };
  emptyText?: string;
  /** Keep group order as given instead of ranking across groups. */
  keepOrder?: boolean;
  onClose: () => void;
  autoSelectFirst?: boolean;
}

export function ListPalette({ placeholder, items, hint, anchor, emptyText = "No matches", keepOrder, onClose, autoSelectFirst = true }: Props) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(autoSelectFirst ? 0 : -1);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  /** The panel itself — never the wrapper behind it. */
  const panelRef = useRef<HTMLDivElement>(null);
  const windowFocused = useUi((s) => s.windowFocused);

  const results = useMemo(() => {
    if (!q.trim()) return items.map((it) => ({ it, indices: [] as number[] }));
    const out: { it: PaletteItem; indices: number[]; score: ReturnType<typeof fuzzyMatch> }[] = [];
    for (const it of items) {
      const m = fuzzyMatch(q, it.label) ?? (it.keywords ? fuzzyMatch(q, it.keywords) : null) ?? (it.detail ? fuzzyMatch(q, it.detail) : null);
      if (m) out.push({ it, indices: fuzzyMatch(q, it.label)?.indices ?? [], score: m });
    }
    if (!keepOrder) out.sort((a, b) => compareMatches(a.score!, b.score!));
    return out;
  }, [q, items, keepOrder]);

  useEffect(() => setSel(autoSelectFirst ? 0 : -1), [q, autoSelectFirst]);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-i="${sel}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  // Click-outside means outside the *panel*. The centred variant sits in a
  // full-screen wrapper, so testing against the wrapper meant every click was
  // inside it and the palette never closed.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("mousedown", onDown, true);
    return () => window.removeEventListener("mousedown", onDown, true);
  }, [onClose]);

  const choose = (i: number, e: { altKey: boolean; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }) => {
    const r = results[i];
    if (!r) return;
    onClose();
    r.it.onSelect({ alt: e.altKey, mod: e.metaKey || e.ctrlKey, shift: e.shiftKey });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(results.length - 1, s + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(0, s - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(sel, e);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  // group rendering preserving result order
  const rendered: ReactNode[] = [];
  let lastGroup: string | undefined;
  results.forEach((r, i) => {
    if (r.it.group !== lastGroup) {
      lastGroup = r.it.group;
      if (r.it.group) rendered.push(<div key={`g_${r.it.group}_${i}`} className="grp">{r.it.group}</div>);
    }
    rendered.push(
      <button
        key={r.it.id}
        data-i={i}
        role="option"
        aria-selected={i === sel}
        className="it"
        onMouseEnter={() => setSel(i)}
        onClick={(e) => choose(i, e)}
      >
        {r.it.icon && <span className="ic">{r.it.icon}</span>}
        <span>
          {highlightChunks(r.it.label, r.indices).map((c, j) => (c.hit ? <mark key={j}>{c.text}</mark> : <span key={j}>{c.text}</span>))}
        </span>
        {r.it.detail && <span className="k2 truncate">{r.it.detail}</span>}
        {r.it.kbd && <span className="kbd">{r.it.kbd}</span>}
      </button>,
    );
  });

  const body = (
    <>
      <div className={anchor ? "field" : "in"} style={anchor ? { height: 22, marginBottom: 4, font: "var(--t-callout)" } : undefined}>
        {anchor ? (
          <span className="glyph">
            <Search />
          </span>
        ) : (
          <Search />
        )}
        <input ref={inputRef} value={q} placeholder={placeholder} onChange={(e) => setQ(e.target.value)} onKeyDown={onKeyDown} aria-label={placeholder} />
      </div>
      <div ref={listRef} className="list" role="listbox" style={anchor ? { maxHeight: 300, overflow: "auto", padding: 0 } : undefined}>
        {rendered.length ? rendered : <div className="none secondary" style={{ padding: "12px 8px", textAlign: "center", font: "var(--t-callout)" }}>{emptyText}</div>}
      </div>
      {hint && <div className="hint">{hint}</div>}
    </>
  );

  if (anchor) {
    return (
      <div ref={panelRef} className={`popover arrow pal${windowFocused ? "" : " inactive"}`} style={{ left: anchor.left, top: anchor.top, width: anchor.width ?? 300, position: "fixed", boxShadow: "var(--shadow-float), 0 0 0 var(--hairline) var(--separator)" }}>
        {body}
      </div>
    );
  }
  return (
    <div className="pal-wrap">
      <div className="pal" role="dialog" ref={panelRef}>
        {body}
      </div>
    </div>
  );
}
