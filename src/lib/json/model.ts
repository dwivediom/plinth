/**
 * The JSON document, flattened once.
 *
 * Every fast large-file viewer works the same way and it is worth saying why:
 * a recursive React tree renders a component per node, so a 200,000-node
 * document is 200,000 components and the tab dies. Instead the document is
 * walked **once** into a flat array, each node recording where its subtree
 * ends, and the view renders only the rows on screen.
 *
 * That gives three properties this depends on:
 *
 *   • **Collapsing is O(1)** — `end` is the index just past the last
 *     descendant, so a closed container is skipped with one jump rather than
 *     by traversing it.
 *   • **Search is one linear scan**, no tree walking, and can be restricted
 *     to keys or to values because each node knows which it has.
 *   • **Nothing recurses.** The flatten uses an explicit stack, so a
 *     pathologically deep document cannot blow the call stack — which is the
 *     usual way a JSON viewer dies on real data.
 */

export type JsonKind = "object" | "array" | "string" | "number" | "boolean" | "null";

export interface JsonNode {
  /** Position in the flat array, and the row's stable identity. */
  i: number;
  depth: number;
  /** Key in the parent object, index in the parent array, or null at the root. */
  key: string | null;
  /** True when `key` is an array index rather than an object key. */
  indexed: boolean;
  kind: JsonKind;
  /** Primitives only. Containers carry `count` instead. */
  value: string | number | boolean | null;
  /** Direct children, for containers. */
  count: number;
  parent: number;
  /** One past the last descendant: `nodes.slice(i + 1, end)` is the subtree. */
  end: number;
}

export interface JsonDoc {
  nodes: JsonNode[];
  /** Bytes of the source text, for the header. */
  bytes: number;
  /** True when the document is big enough that we avoid re-serialising it. */
  huge: boolean;
}

/** Past this, pretty-printing and whole-document operations are not offered. */
export const HUGE_BYTES = 5_000_000;

const kindOf = (v: unknown): JsonKind =>
  v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "object" ? "object" : (typeof v as JsonKind);

/**
 * Flatten a parsed value. Iterative on purpose — see the note above.
 *
 * The traversal keeps a stack of "frames", each a container being emitted and
 * the list of its remaining children, so the order is exactly a depth-first
 * pre-order and every parent is written before its children.
 */
export function flatten(root: unknown, bytes = 0): JsonDoc {
  const nodes: JsonNode[] = [];

  interface Frame {
    /** Index of the container node in `nodes`. */
    self: number;
    entries: [string, unknown][];
    at: number;
    indexed: boolean;
  }

  const push = (key: string | null, indexed: boolean, value: unknown, depth: number, parent: number): number => {
    const kind = kindOf(value);
    const container = kind === "object" || kind === "array";
    nodes.push({
      i: nodes.length,
      depth,
      key,
      indexed,
      kind,
      value: container ? null : (value as string | number | boolean | null),
      count: container ? (Array.isArray(value) ? value.length : Object.keys(value as object).length) : 0,
      parent,
      // Filled in when the container closes; a leaf ends immediately.
      end: nodes.length + 1,
    });
    return nodes.length - 1;
  };

  const entriesOf = (v: unknown): [string, unknown][] =>
    Array.isArray(v) ? v.map((x, n) => [String(n), x] as [string, unknown]) : Object.entries(v as Record<string, unknown>);

  const rootIndex = push(null, false, root, 0, -1);
  const stack: Frame[] = [];
  if (nodes[rootIndex].kind === "object" || nodes[rootIndex].kind === "array") {
    stack.push({ self: rootIndex, entries: entriesOf(root), at: 0, indexed: Array.isArray(root) });
  }

  while (stack.length) {
    const frame = stack[stack.length - 1];
    if (frame.at >= frame.entries.length) {
      nodes[frame.self].end = nodes.length;
      stack.pop();
      continue;
    }
    const [key, value] = frame.entries[frame.at++];
    const depth = nodes[frame.self].depth + 1;
    const idx = push(key, frame.indexed, value, depth, frame.self);
    const kind = nodes[idx].kind;
    if (kind === "object" || kind === "array") {
      stack.push({ self: idx, entries: entriesOf(value), at: 0, indexed: kind === "array" });
    }
  }

  return { nodes, bytes, huge: bytes > HUGE_BYTES };
}

/** Parse and flatten. The error carries the offset so the text mode can point at it. */
export function parseJson(text: string): { doc: JsonDoc; error: null } | { doc: null; error: { message: string; offset: number | null } } {
  try {
    const value = JSON.parse(text);
    return { doc: flatten(value, new Blob([text]).size), error: null };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // V8: "… in JSON at position 1234". Other engines word it differently, so
    // a missing offset is normal rather than a failure.
    const at = /position (\d+)/.exec(message)?.[1];
    return { doc: null, error: { message, offset: at ? Number(at) : null } };
  }
}

// ───────────────────────── what is on screen ─────────────────────────

/**
 * The rows to render, given which containers are open.
 *
 * A closed container costs one jump rather than a walk of its subtree, so
 * this is proportional to what is visible, not to the size of the document.
 */
export function visibleRows(doc: JsonDoc, expanded: Set<number>): number[] {
  const out: number[] = [];
  const n = doc.nodes;
  let i = 0;
  while (i < n.length) {
    const node = n[i];
    out.push(i);
    const container = node.kind === "object" || node.kind === "array";
    if (container && !expanded.has(i)) {
      i = node.end;
      continue;
    }
    i += 1;
  }
  return out;
}

/** Containers down to `depth`, for "expand to level N" and the initial view. */
export function expandToDepth(doc: JsonDoc, depth: number): Set<number> {
  const out = new Set<number>();
  for (const node of doc.nodes) {
    if ((node.kind === "object" || node.kind === "array") && node.depth < depth) out.add(node.i);
  }
  return out;
}

/** Every container. Refused on a huge document by the caller, not here. */
export function expandAll(doc: JsonDoc): Set<number> {
  const out = new Set<number>();
  for (const node of doc.nodes) if (node.kind === "object" || node.kind === "array") out.add(node.i);
  return out;
}

/** The chain of ancestors of `i`, roots first, excluding `i` itself. */
export function ancestors(doc: JsonDoc, i: number): number[] {
  const out: number[] = [];
  let p = doc.nodes[i]?.parent ?? -1;
  while (p >= 0) {
    out.push(p);
    p = doc.nodes[p].parent;
  }
  return out.reverse();
}

// ───────────────────────── search ─────────────────────────

export type SearchScope = "all" | "keys" | "values";

export interface SearchOptions {
  query: string;
  scope: SearchScope;
  caseSensitive: boolean;
  /** Treat the query as a regular expression. Invalid patterns match nothing. */
  regex: boolean;
}

/** The text a value is searched and displayed as. */
export function valueText(node: JsonNode): string {
  switch (node.kind) {
    case "string":
      return String(node.value);
    case "null":
      return "null";
    case "object":
    case "array":
      return "";
    default:
      return String(node.value);
  }
}

/**
 * Every node that matches, in document order.
 *
 * Searching keys and values separately is the feature people actually reach
 * for: `id` appears in half the keys of a typical document and in none of the
 * values you were looking for.
 */
export function search(doc: JsonDoc, opts: SearchOptions): number[] {
  const q = opts.query;
  if (!q) return [];
  let test: (s: string) => boolean;
  if (opts.regex) {
    let re: RegExp;
    try {
      re = new RegExp(q, opts.caseSensitive ? "" : "i");
    } catch {
      return [];
    }
    test = (s) => re.test(s);
  } else {
    const needle = opts.caseSensitive ? q : q.toLowerCase();
    test = (s) => (opts.caseSensitive ? s : s.toLowerCase()).includes(needle);
  }

  const out: number[] = [];
  for (const node of doc.nodes) {
    const keyHit = opts.scope !== "values" && node.key != null && test(node.key);
    const valueHit = opts.scope !== "keys" && node.kind !== "object" && node.kind !== "array" && test(valueText(node));
    if (keyHit || valueHit) out.push(node.i);
  }
  return out;
}

/** Matches and the ancestors needed to see them — the rows for "filter". */
export function filterRows(doc: JsonDoc, matches: number[]): number[] {
  const keep = new Set<number>();
  for (const m of matches) {
    keep.add(m);
    for (const a of ancestors(doc, m)) keep.add(a);
  }
  return [...keep].sort((a, b) => a - b);
}

// ───────────────────────── paths ─────────────────────────

/** `$.users[2].email` — the form every JSON tool understands. */
export function jsonPath(doc: JsonDoc, i: number): string {
  const chain = [...ancestors(doc, i), i];
  let out = "$";
  for (const idx of chain) {
    const node = doc.nodes[idx];
    if (node.key == null) continue;
    out += node.indexed ? `[${node.key}]` : /^[A-Za-z_]\w*$/.test(node.key) ? `.${node.key}` : `[${JSON.stringify(node.key)}]`;
  }
  return out;
}

/** The subtree at `i`, rebuilt as a value. Used for copy and for the detail pane. */
export function valueAt(doc: JsonDoc, i: number): unknown {
  const node = doc.nodes[i];
  if (!node) return undefined;
  if (node.kind !== "object" && node.kind !== "array") return node.value;
  const build = (at: number): unknown => {
    const n = doc.nodes[at];
    if (n.kind !== "object" && n.kind !== "array") return n.value;
    const children: number[] = [];
    let c = at + 1;
    while (c < n.end) {
      children.push(c);
      c = doc.nodes[c].end;
    }
    if (n.kind === "array") return children.map(build);
    const obj: Record<string, unknown> = {};
    for (const ch of children) obj[doc.nodes[ch].key ?? ""] = build(ch);
    return obj;
  };
  return build(i);
}
