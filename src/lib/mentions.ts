import type { ObjectKind, SchemaIndex, TableRef } from "../ipc/types";

/** A table or view the AI pane can mention, pin, or open. */
export interface TableEntry {
  schema: string;
  name: string;
  kind: ObjectKind;
  /** `schema.name` — what `@mentions` and pins are keyed by. */
  qualified: string;
  rowEstimate: number | null;
  columns: string[];
}

export function tableIndex(schema: SchemaIndex | null): TableEntry[] {
  if (!schema) return [];
  const columns = new Map<string, string[]>();
  for (const c of schema.columns) {
    const key = `${c.schema}.${c.table}`;
    const list = columns.get(key) ?? [];
    list.push(c.column);
    columns.set(key, list);
  }
  const out: TableEntry[] = [];
  for (const s of schema.schemas) {
    if (s.isSystem) continue;
    for (const o of s.objects) {
      if (o.kind !== "table" && o.kind !== "view" && o.kind !== "materialized-view") continue;
      const qualified = `${o.schema}.${o.name}`;
      out.push({ schema: o.schema, name: o.name, kind: o.kind, qualified, rowEstimate: o.rowEstimate, columns: columns.get(qualified) ?? [] });
    }
  }
  return out;
}

export function tableRef(entry: TableEntry): TableRef {
  return { schema: entry.schema, name: entry.name };
}

/** Resolve `orders` or `public.orders`, case-insensitively. Bare names are ambiguous across schemas — first match wins, which matches how the sidebar lists them. */
export function findTable(index: TableEntry[], token: string): TableEntry | null {
  const t = token.trim().toLowerCase().replace(/^@/, "").replace(/[;,.)]+$/, "");
  if (!t) return null;
  return index.find((e) => e.qualified.toLowerCase() === t) ?? index.find((e) => e.name.toLowerCase() === t) ?? null;
}

/** Every `@table` in the text that resolves to something real, de-duplicated. */
export function mentionsIn(text: string, index: TableEntry[]): TableEntry[] {
  const seen = new Map<string, TableEntry>();
  for (const m of text.matchAll(/@([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?)/g)) {
    const entry = findTable(index, m[1]);
    if (entry) seen.set(entry.qualified, entry);
  }
  return [...seen.values()];
}

/** The `@…` token the caret sits in, for the autocomplete popup. */
export function mentionAtCaret(text: string, caret: number): { from: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  const token = before.slice(at + 1);
  // A space (or another @) ends the token; a dot is part of a qualified name.
  if (/[\s@]/.test(token)) return null;
  return { from: at, query: token };
}

/** Rank by how the person is likely typing it: prefix, then substring. */
export function matchTables(index: TableEntry[], query: string, limit = 8): TableEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return index.slice(0, limit);
  const score = (e: TableEntry): number => {
    const name = e.name.toLowerCase();
    const qual = e.qualified.toLowerCase();
    if (name === q || qual === q) return 0;
    if (name.startsWith(q)) return 1;
    if (qual.startsWith(q)) return 2;
    if (name.includes(q)) return 3;
    if (qual.includes(q)) return 4;
    return 99;
  };
  return index
    .map((e) => ({ e, s: score(e) }))
    .filter((x) => x.s < 99)
    .sort((a, b) => a.s - b.s || a.e.qualified.localeCompare(b.e.qualified))
    .slice(0, limit)
    .map((x) => x.e);
}

/**
 * Split prose into text and `@table` runs so the chat can render the mentions
 * as buttons. Only mentions that resolve become chips; anything else stays
 * literal, so an email address is never mistaken for a table.
 */
export type ProseChunk = { text: string } | { mention: TableEntry; raw: string };

export function splitMentions(text: string, index: TableEntry[]): ProseChunk[] {
  const out: ProseChunk[] = [];
  let last = 0;
  for (const m of text.matchAll(/@([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?)/g)) {
    const entry = findTable(index, m[1]);
    if (!entry || m.index == null) continue;
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push({ mention: entry, raw: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}
