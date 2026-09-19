import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AlertTriangle, Braces, Brackets, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Copy, Filter, Info, ListTree, Regex, Search, Type, X } from "lucide-react";
import { lineColOf, parseTolerant, type JsonIssue } from "../../lib/json/tolerant";
import {
  ancestors,
  expandAll,
  expandToDepth,
  filterRows,
  jsonPath,
  search as searchDoc,
  valueAt,
  valueText,
  visibleRows,
  type JsonDoc,
  type JsonNode,
  type SearchScope,
} from "../../lib/json/model";
import { toast } from "../../state/overlays";

/**
 * The JSON viewer.
 *
 * Built rather than borrowed, for two reasons: the good libraries bring their
 * own look, which in an app like this reads as a widget bolted on; and the
 * part that actually matters — staying fast on a document with hundreds of
 * thousands of nodes — is the flat index in `lib/json/model.ts` plus the
 * virtualiser this app already uses for the data grid.
 *
 * Everything on screen is one row of a virtual list. Nothing recurses.
 */

const ROW = 22;
/** Past this many nodes, expand-all is refused rather than being slow. */
const EXPAND_ALL_LIMIT = 50_000;

export interface JsonViewerProps {
  /** The document, as text. Parsing happens here so errors can be shown. */
  text: string;
  /** Shown in the header — `orders.meta`, a file name, or nothing. */
  title?: string;
  /** Extra controls for the header (Edit, Close, …). */
  actions?: React.ReactNode;
  /** A column reference, so paths can be copied as SQL as well as JSONPath. */
  sqlColumn?: string | null;
  /** Compact spacing for the inspector's narrow column. */
  dense?: boolean;
  /**
   * Height the list to its content, up to this many rows.
   *
   * A two-key document in a side panel should be two rows tall, not a
   * 400-pixel box with one line in it. Beyond the cap it scrolls as usual.
   */
  maxRows?: number;
}

export function JsonViewer({ text, title, actions, sqlColumn, dense, maxRows }: JsonViewerProps) {
  // Tolerant on purpose: a document is usually opened *because* something is
  // wrong with it, and "unexpected token at position 918443001" is not an
  // answer. See `lib/json/tolerant.ts`.
  const parsed = useMemo(() => parseTolerant(text), [text]);
  const doc = parsed.doc;
  const issues = parsed.issues;
  const errors = useMemo(() => issues.filter((i) => i.kind === "error"), [issues]);
  const issueByNode = useMemo(() => {
    const m = new Map<number, JsonIssue>();
    // The first problem at a node is the one worth showing on the row.
    for (const it of issues) if (!m.has(it.node)) m.set(it.node, it);
    return m;
  }, [issues]);
  const [showIssues, setShowIssues] = useState(false);
  const [issueAt, setIssueAt] = useState(0);

  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<SearchScope>("all");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [onlyMatches, setOnlyMatches] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  // A new document starts with its first two levels open: enough to see the
  // shape, never enough to be slow.
  useEffect(() => {
    if (doc) setExpanded(expandToDepth(doc, 2));
    setSelected(null);
    setCursor(0);
  }, [doc]);

  const matches = useMemo(
    () => (doc && query ? searchDoc(doc, { query, scope, caseSensitive, regex }) : []),
    [doc, query, scope, caseSensitive, regex],
  );
  const matchSet = useMemo(() => new Set(matches), [matches]);

  // Filtering shows matches and the way down to them; otherwise the ordinary
  // expand/collapse state decides.
  const rows = useMemo(() => {
    if (!doc) return [];
    if (onlyMatches && query) return filterRows(doc, matches);
    return visibleRows(doc, expanded);
  }, [doc, expanded, onlyMatches, query, matches]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW,
    overscan: 24,
  });

  const toggle = useCallback((i: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }, []);

  /** Open everything down to a node and scroll it into view. */
  const reveal = useCallback(
    (i: number) => {
      if (!doc) return;
      setExpanded((prev) => {
        const next = new Set(prev);
        for (const a of ancestors(doc, i)) next.add(a);
        return next;
      });
      setSelected(i);
      // The row index is only known after the expansion has been applied.
      requestAnimationFrame(() => {
        const at = visibleRows(doc, new Set([...expanded, ...ancestors(doc, i)])).indexOf(i);
        if (at >= 0) virtualizer.scrollToIndex(at, { align: "center" });
      });
    },
    [doc, expanded, virtualizer],
  );

  const step = useCallback(
    (delta: number) => {
      if (!matches.length) return;
      const next = (cursor + delta + matches.length) % matches.length;
      setCursor(next);
      reveal(matches[next]);
    },
    [cursor, matches, reveal],
  );

  /** Walk the problems. Each one knows its node, so this is the same reveal
   *  the search uses. */
  const stepIssue = (delta: number) => {
    if (!issues.length) return;
    const next = (issueAt + delta + issues.length) % issues.length;
    setIssueAt(next);
    reveal(issues[next].node);
  };

  const copy = (what: string, label: string) =>
    void navigator.clipboard.writeText(what).then(
      () => toast(`Copied ${label}`),
      () => toast(`Could not reach the clipboard — ${label} is ${what}`, "error"),
    );

  if (!doc) return null;

  const root = doc.nodes[0];
  const tooBig = doc.nodes.length > EXPAND_ALL_LIMIT;

  return (
    <div className={`jsonview${dense ? " dense" : ""}`}>
      <div className="jbar">
        {title && <span className="jtitle truncate">{title}</span>}
        <span className="jstat">
          {root.kind === "array" ? <Brackets /> : <Braces />}
          {formatCount(doc.nodes.length)} nodes
          {doc.bytes > 0 && ` · ${formatBytes(doc.bytes)}`}
        </span>
        <span className="spacer" />
        {/* The inspector's column is ~190px. Expand-all and friends live in
            the enlarged view, where there is room to label them. */}
        {!dense && (
          <>
            <button
              className="icon-btn small"
              title={tooBig ? `Too large to expand at once (${formatCount(doc.nodes.length)} nodes)` : "Expand everything"}
              disabled={tooBig}
              onClick={() => setExpanded(expandAll(doc))}
            >
              <ChevronsUpDown />
            </button>
            <button className="icon-btn small" title="Collapse everything" onClick={() => setExpanded(new Set())}>
              <ChevronsDownUp />
            </button>
            <button className="icon-btn small" title="Expand two levels" onClick={() => setExpanded(expandToDepth(doc, 2))}>
              <ListTree />
            </button>
          </>
        )}
        {actions}
      </div>

      {/* Not valid, but open anyway — with the problems in hand. */}
      {!!issues.length && (
        <div className={`jissues${errors.length ? " bad" : ""}`}>
          <button className="head" onClick={() => setShowIssues((v) => !v)} aria-expanded={showIssues}>
            {errors.length ? <AlertTriangle /> : <Info />}
            <b>
              {errors.length
                ? `${errors.length} problem${errors.length === 1 ? "" : "s"}`
                : `${issues.length} thing${issues.length === 1 ? "" : "s"} that are not valid JSON`}
            </b>
            <span className="jsub">
              {parsed.truncated ? "the document is cut short — everything before the cut is shown" : "shown anyway; the tree is what could be read"}
            </span>
            <span className="spacer" />
            <span className="kbd">{showIssues ? "hide" : "show"}</span>
          </button>
          {showIssues && (
            <div className="list">
              {issues.slice(0, 200).map((it, n) => {
                const { line, column } = lineColOf(text, it.offset);
                return (
                  <button
                    key={n}
                    className={`jissue ${it.kind}${n === issueAt ? " on" : ""}`}
                    onClick={() => {
                      setIssueAt(n);
                      reveal(it.node);
                    }}
                  >
                    <span className="where">
                      line {line}:{column}
                    </span>
                    <span className="what">{it.message}</span>
                    <code className="path truncate">{it.path}</code>
                  </button>
                );
              })}
              {issues.length > 200 && <div className="more">…and {formatCount(issues.length - 200)} more</div>}
            </div>
          )}
        </div>
      )}

      <div className="jsearch">
        <span className="glyph">
          <Search />
        </span>
        <input
          value={query}
          placeholder="Search"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              step(e.shiftKey ? -1 : 1);
            }
            if (e.key === "Escape") setQuery("");
          }}
          aria-label="Search the document"
        />
        {/* The one control that matters: `id` is in half the keys of a real
            document and in none of the values you were looking for. */}
        <div className="scopes" role="group" aria-label="Search in">
          {(["all", "keys", "values"] as const).map((s) => (
            <button key={s} className={scope === s ? "on" : ""} onClick={() => setScope(s)} title={`Search ${s === "all" ? "keys and values" : s} only`}>
              {s === "all" ? "both" : s}
            </button>
          ))}
        </div>
        {!dense && (
          <>
            <button className={`icon-btn small${caseSensitive ? " on" : ""}`} aria-pressed={caseSensitive} title="Match case" onClick={() => setCaseSensitive((v) => !v)}>
              <Type />
            </button>
            <button className={`icon-btn small${regex ? " on" : ""}`} aria-pressed={regex} title="Regular expression" onClick={() => setRegex((v) => !v)}>
              <Regex />
            </button>
            <button className={`icon-btn small${onlyMatches ? " on" : ""}`} aria-pressed={onlyMatches} title="Show only matches and the path to them" onClick={() => setOnlyMatches((v) => !v)}>
              <Filter />
            </button>
          </>
        )}
        {!query && !!issues.length && (
          <span className="jcount">
            <button className="icon-btn small" title="Previous problem" onClick={() => stepIssue(-1)}>
              ‹
            </button>
            <span>{issueAt + 1} of {formatCount(issues.length)}</span>
            <button className="icon-btn small" title="Next problem" onClick={() => stepIssue(1)}>
              ›
            </button>
          </span>
        )}
        {query && (
          <span className="jcount">
            {matches.length ? `${cursor + 1} of ${formatCount(matches.length)}` : "none"}
            <button className="icon-btn small" title="Previous (⇧↵)" onClick={() => step(-1)} disabled={!matches.length}>
              ‹
            </button>
            <button className="icon-btn small" title="Next (↵)" onClick={() => step(1)} disabled={!matches.length}>
              ›
            </button>
            <button className="icon-btn small" title="Clear" onClick={() => setQuery("")}>
              <X />
            </button>
          </span>
        )}
      </div>

      <div
        className="jrows"
        ref={scroller}
        style={maxRows ? { height: Math.max(ROW, Math.min(rows.length, maxRows) * ROW), flex: "none" } : undefined}
      >
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((v) => {
            const i = rows[v.index];
            const node = doc.nodes[i];
            if (!node) return null;
            return (
              <Row
                key={i}
                node={node}
                doc={doc}
                top={v.start}
                open={expanded.has(i)}
                matched={matchSet.has(i)}
                current={matches[cursor] === i}
                selected={selected === i}
                query={query}
                scope={scope}
                issue={issueByNode.get(i) ?? null}
                onToggle={() => toggle(i)}
                onSelect={() => setSelected(i)}
              />
            );
          })}
        </div>
      </div>

      {selected != null && doc.nodes[selected] && (
        <div className="jfoot">
          <code className="jpath selectable truncate">{jsonPath(doc, selected)}</code>
          <span className="spacer" />
          <button className="btn mini" onClick={() => copy(jsonPath(doc, selected), "the path")}>
            <Copy /> Path
          </button>
          {!dense && sqlColumn && (
            <button className="btn mini" onClick={() => copy(sqlAccessor(doc, selected, sqlColumn), "the SQL accessor")}>
              <Copy /> SQL
            </button>
          )}
          {!dense && (
            <button className="btn mini" onClick={() => copy(JSON.stringify(valueAt(doc, selected), null, 2), "the value")}>
              <Copy /> Value
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ───────────────────────── one row ─────────────────────────

function Row({
  node,
  doc,
  top,
  open,
  matched,
  current,
  selected,
  query,
  scope,
  issue,
  onToggle,
  onSelect,
}: {
  node: JsonNode;
  doc: JsonDoc;
  top: number;
  open: boolean;
  matched: boolean;
  current: boolean;
  selected: boolean;
  query: string;
  scope: SearchScope;
  issue: JsonIssue | null;
  onToggle: () => void;
  onSelect: () => void;
}) {
  const container = node.kind === "object" || node.kind === "array";
  const brace = node.kind === "array" ? ["[", "]"] : ["{", "}"];
  return (
    <div
      className={`jrow${selected ? " sel" : ""}${current ? " cur" : ""}${matched ? " hit" : ""}${issue ? ` bad ${issue.kind}` : ""}`}
      title={issue ? issue.message : undefined}
      style={{ transform: `translateY(${top}px)`, paddingLeft: 8 + node.depth * 14 }}
      onMouseDown={onSelect}
      onDoubleClick={container ? onToggle : undefined}
      role="treeitem"
      aria-expanded={container ? open : undefined}
      aria-level={node.depth + 1}
    >
      {container ? (
        <button className="tw" onClick={onToggle} aria-label={open ? "Collapse" : "Expand"} tabIndex={-1}>
          {open ? <ChevronDown /> : <ChevronRight />}
        </button>
      ) : (
        <span className="tw" />
      )}
      {node.key != null && (
        <span className={node.indexed ? "jidx" : "jkey"}>
          {scope !== "values" ? <Mark text={node.key} query={query} /> : node.key}
          <span className="jcolon">:</span>
        </span>
      )}
      {container ? (
        <span className="jsum">
          <span className="jbrace">{brace[0]}</span>
          {open ? "" : ` ${formatCount(node.count)} ${node.kind === "array" ? (node.count === 1 ? "item" : "items") : node.count === 1 ? "key" : "keys"} `}
          {!open && <span className="jbrace">{brace[1]}</span>}
        </span>
      ) : (
        <span className={`jval ${node.kind}`}>
          {node.kind === "string" ? '"' : ""}
          {scope !== "keys" ? <Mark text={valueText(node)} query={query} /> : valueText(node)}
          {node.kind === "string" ? '"' : ""}
        </span>
      )}
      {issue && (
        <span className={`jflag ${issue.kind}`} aria-label={issue.message}>
          {issue.kind === "error" ? <AlertTriangle /> : <Info />}
        </span>
      )}
      {void doc}
    </div>
  );
}

/** Highlight the matched run. Plain text when there is no query. */
function Mark({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark>{text.slice(at, at + query.length)}</mark>
      {text.slice(at + query.length)}
    </>
  );
}

// ───────────────────────── helpers ─────────────────────────

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  return n.toLocaleString();
}

function formatBytes(n: number): string {
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
  if (n >= 1 << 10) return `${Math.round(n / (1 << 10))} kB`;
  return `${n} B`;
}

/** `meta -> 'address' ->> 'city'` — the Postgres form, as the inspector does. */
function sqlAccessor(doc: JsonDoc, i: number, column: string): string {
  const chain = [...ancestors(doc, i), i].map((x) => doc.nodes[x]).filter((n) => n.key != null);
  if (!chain.length) return column;
  return chain.reduce((acc, n, idx) => {
    const op = idx === chain.length - 1 ? "->>" : "->";
    return `${acc} ${op} ${n.indexed ? n.key : `'${n.key}'`}`;
  }, column);
}
