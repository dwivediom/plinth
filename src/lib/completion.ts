import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import type { SchemaGraph, SchemaIndex } from "../ipc/types";
import { adjacency, key as tableKey, type JoinStep } from "./graph";

/**
 * Schema-aware completion.
 *
 * `lang-sql` already completes table and column *names*. What it cannot do is
 * know that `orders` joins `customers` on `customer_id`, or that `o.` means
 * the table aliased `o` three lines up. Both are things we hold — the schema
 * index and the FK graph from PLAN-6 — and both are what makes completion
 * feel like an editor that read your database rather than your keystrokes.
 */

export interface CompletionSchema {
  schema: SchemaIndex | null;
  graph: SchemaGraph | null;
}

interface TableInfo {
  name: string;
  qualified: string;
  schema: string;
  kind: string;
  rowEstimate: number | null;
  columns: string[];
}

function tablesOf(schema: SchemaIndex | null): TableInfo[] {
  if (!schema) return [];
  const columns = new Map<string, string[]>();
  for (const c of schema.columns) {
    const k = `${c.schema}.${c.table}`.toLowerCase();
    const list = columns.get(k) ?? [];
    list.push(c.column);
    columns.set(k, list);
  }
  const out: TableInfo[] = [];
  for (const s of schema.schemas) {
    if (s.isSystem) continue;
    for (const o of s.objects) {
      if (o.kind === "function" || o.kind === "sequence") continue;
      out.push({
        name: o.name,
        qualified: `${o.schema}.${o.name}`,
        schema: o.schema,
        kind: o.kind,
        rowEstimate: o.rowEstimate,
        columns: columns.get(`${o.schema}.${o.name}`.toLowerCase()) ?? [],
      });
    }
  }
  return out;
}

function rows(n: number | null): string {
  if (n == null) return "";
  if (n >= 1_000_000) return `~${(n / 1_000_000).toFixed(1)}M rows`;
  if (n >= 1_000) return `~${(n / 1_000).toFixed(0)}k rows`;
  return `~${n} rows`;
}

/** `FROM orders o`, `JOIN customers AS c` → alias → table. */
export function aliasesIn(sql: string, tables: TableInfo[]): Map<string, TableInfo> {
  const byName = new Map(tables.map((t) => [t.name.toLowerCase(), t]));
  const out = new Map<string, TableInfo>();
  const re = /\b(?:from|join|update|into)\s+([A-Za-z_][\w$]*)(?:\.([A-Za-z_][\w$]*))?(?:\s+(?:as\s+)?([A-Za-z_][\w$]*))?/gi;
  for (const m of sql.matchAll(re)) {
    const bare = (m[2] ?? m[1]).toLowerCase();
    const table = byName.get(bare);
    if (!table) continue;
    // The table always answers to its own name; an alias adds a second key.
    out.set(table.name.toLowerCase(), table);
    const alias = m[3]?.toLowerCase();
    if (alias && !["on", "where", "group", "order", "limit", "join", "inner", "left", "right", "full", "cross", "set", "values"].includes(alias)) {
      out.set(alias, table);
    }
  }
  return out;
}

function columnCompletions(table: TableInfo, boostBase = 0): Completion[] {
  return table.columns.map((c) => ({
    label: c,
    type: "property",
    detail: table.name,
    boost: boostBase,
  }));
}

/**
 * `JOIN ` after a table that has a foreign key offers the whole clause — the
 * one completion that removes the part people actually get wrong.
 */
function joinCompletions(graph: SchemaGraph | null, inScope: TableInfo[], tables: TableInfo[]): Completion[] {
  if (!graph || !inScope.length) return [];
  const adj = adjacency(graph);
  const seen = new Set<string>();
  const out: Completion[] = [];

  for (const from of inScope) {
    for (const step of adj.get(tableKey({ schema: from.schema, name: from.name })) ?? []) {
      const target = step.to;
      const targetName = target.schema ? `${target.schema}.${target.name}` : target.name;
      if (seen.has(targetName)) continue;
      seen.add(targetName);
      const known = tables.find((t) => t.name.toLowerCase() === target.name.toLowerCase());
      if (!known) continue;
      const on = clause(step, from.name);
      out.push({
        label: `${target.name} ON ${on}`,
        apply: `${target.name} ON ${on}`,
        type: "keyword",
        detail: step.inferred ? "inferred key" : "foreign key",
        info: `Join ${from.name} to ${target.name}${step.inferred ? " — this relationship is inferred from naming, not a declared constraint" : ""}.`,
        // Ahead of bare table names: this is the answer, not an ingredient.
        boost: 99,
      });
    }
  }
  return out;
}

function clause(step: JoinStep, fromAlias: string): string {
  const left = fromAlias;
  const right = step.to.name;
  return step.fromColumns.map((c, i) => `${left}.${c} = ${right}.${step.toColumns[i] ?? step.toColumns[0]}`).join(" AND ");
}

/**
 * The completion source. Ordered by how specific the context is: a qualifier
 * beats a clause, a clause beats "everything in the database".
 */
export function sqlCompletions({ schema, graph }: CompletionSchema) {
  const tables = tablesOf(schema);

  return (context: CompletionContext): CompletionResult | null => {
    if (!tables.length) return null;
    const line = context.state.doc.lineAt(context.pos);
    const before = context.state.doc.sliceString(Math.max(0, context.pos - 4000), context.pos);
    const aliases = aliasesIn(before, tables);

    // 1. `alias.` or `table.` — only that table's columns, nothing else.
    const qualified = /([A-Za-z_][\w$]*)\.([A-Za-z_][\w$]*)?$/.exec(before);
    if (qualified) {
      const owner = aliases.get(qualified[1].toLowerCase()) ?? tables.find((t) => t.name.toLowerCase() === qualified[1].toLowerCase());
      if (owner) {
        const from = context.pos - (qualified[2]?.length ?? 0);
        return { from, options: columnCompletions(owner, 50), validFor: /^[\w$]*$/ };
      }
    }

    const word = context.matchBefore(/[\w$]*/);
    if (!word || (word.from === word.to && !context.explicit)) return null;

    // 2. Straight after JOIN, with something already in scope: whole clauses.
    const afterJoin = /\bjoin\s+[\w$]*$/i.test(before);
    if (afterJoin) {
      const inScope = [...new Set(aliases.values())];
      const joins = joinCompletions(graph, inScope, tables);
      const plain = tables.map((t) => tableOption(t));
      return { from: word.from, options: [...joins, ...plain], validFor: /^[\w$]*$/ };
    }

    // 3. After FROM / INTO / UPDATE: tables.
    if (/\b(?:from|into|update|table)\s+[\w$]*$/i.test(before)) {
      return { from: word.from, options: tables.map((t) => tableOption(t)), validFor: /^[\w$]*$/ };
    }

    // 4. Anywhere else: columns of the tables already in the statement first,
    //    then every table. Relevance beats alphabetical.
    const inScope = [...new Set(aliases.values())];
    const options: Completion[] = [
      ...inScope.flatMap((t) => columnCompletions(t, 20)),
      ...tables.map((t) => tableOption(t, inScope.includes(t) ? 10 : 0)),
    ];
    if (!options.length) return null;
    return { from: word.from, options, validFor: /^[\w$]*$/ };
    void line;
  };
}

function tableOption(t: TableInfo, boost = 0): Completion {
  return {
    label: t.name,
    type: t.kind === "view" || t.kind === "materialized-view" ? "interface" : "class",
    detail: [t.schema, rows(t.rowEstimate)].filter(Boolean).join(" · "),
    info: t.columns.length ? `${t.columns.length} columns: ${t.columns.slice(0, 12).join(", ")}${t.columns.length > 12 ? "…" : ""}` : undefined,
    boost,
  };
}
