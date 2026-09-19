import type { GraphEdge, SchemaGraph, TableRef } from "../ipc/types";

/** `schema.table`, lower-cased — the key everything in the graph is indexed by. */
export function key(t: TableRef): string {
  return t.schema ? `${t.schema}.${t.name}`.toLowerCase() : t.name.toLowerCase();
}

/** One hop, already oriented from → to so the `ON` clause reads correctly. */
export interface JoinStep {
  from: TableRef;
  fromColumns: string[];
  to: TableRef;
  toColumns: string[];
  inferred: boolean;
}

function step(e: GraphEdge, reversed: boolean): JoinStep {
  return reversed
    ? { from: e.to, fromColumns: e.toColumns, to: e.from, toColumns: e.fromColumns, inferred: e.inferred }
    : { from: e.from, fromColumns: e.fromColumns, to: e.to, toColumns: e.toColumns, inferred: e.inferred };
}

/** Undirected adjacency: a join works in either direction. */
export function adjacency(graph: SchemaGraph): Map<string, JoinStep[]> {
  const out = new Map<string, JoinStep[]>();
  const push = (k: string, s: JoinStep) => {
    const list = out.get(k);
    if (list) list.push(s);
    else out.set(k, [s]);
  };
  for (const e of graph.edges) {
    push(key(e.from), step(e, false));
    push(key(e.to), step(e, true));
  }
  return out;
}

/**
 * Shortest join path between two tables, breadth-first. Declared edges are
 * explored before inferred ones, so a guess is only used when there is no
 * constraint that would do — the same bias the map draws.
 */
export function joinPath(graph: SchemaGraph, from: TableRef | string, to: TableRef | string, adj = adjacency(graph)): JoinStep[] | null {
  const start = typeof from === "string" ? from.toLowerCase() : key(from);
  const goal = typeof to === "string" ? to.toLowerCase() : key(to);
  if (start === goal) return [];

  const seen = new Set([start]);
  let frontier: { at: string; path: JoinStep[] }[] = [{ at: start, path: [] }];
  while (frontier.length) {
    const next: typeof frontier = [];
    for (const { at, path } of frontier) {
      const steps = (adj.get(at) ?? []).slice().sort((a, b) => Number(a.inferred) - Number(b.inferred));
      for (const s of steps) {
        const k = key(s.to);
        if (seen.has(k)) continue;
        const grown = [...path, s];
        if (k === goal) return grown;
        seen.add(k);
        next.push({ at: k, path: grown });
      }
    }
    frontier = next;
  }
  return null;
}

/** `public.orders.customer_id = public.customers.id`, composite keys included. */
export function joinClause(s: JoinStep): string {
  const left = s.from.schema ? `${s.from.schema}.${s.from.name}` : s.from.name;
  const right = s.to.schema ? `${s.to.schema}.${s.to.name}` : s.to.name;
  return s.fromColumns
    .map((c, i) => `${left}.${c} = ${right}.${s.toColumns[i] ?? s.toColumns[0]}`)
    .join(" AND ");
}

/**
 * Every hop needed to join the given tables to each other, de-duplicated.
 * This is what goes in the model's context: a handful of literal `ON` clauses
 * instead of an invitation to guess.
 */
export function joinsFor(graph: SchemaGraph, tables: string[]): JoinStep[] {
  if (tables.length < 2) return [];
  const adj = adjacency(graph);
  const seen = new Set<string>();
  const out: JoinStep[] = [];
  for (let i = 0; i < tables.length; i++) {
    for (let j = i + 1; j < tables.length; j++) {
      for (const s of joinPath(graph, tables[i], tables[j], adj) ?? []) {
        const sig = joinClause(s);
        // a↔b and b↔a are the same hop
        const mirror = joinClause({ ...s, from: s.to, fromColumns: s.toColumns, to: s.from, toColumns: s.fromColumns });
        if (seen.has(sig) || seen.has(mirror)) continue;
        seen.add(sig);
        out.push(s);
      }
    }
  }
  return out;
}

/** Tables one hop away — what the map shows around a filtered match. */
export function neighbours(graph: SchemaGraph, table: string, adj = adjacency(graph)): string[] {
  return (adj.get(table.toLowerCase()) ?? []).map((s) => key(s.to));
}
