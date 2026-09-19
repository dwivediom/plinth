import type { Cell, ColumnDesc } from "../ipc/types";
import { isNumericType } from "../ipc/types";

/**
 * Which column is the axis and which is the bar.
 *
 * The whole difficulty is that **a number is not automatically a measure**.
 * `SELECT extract(year …) AS year, extract(month …) AS month, count(*) AS n`
 * is three numeric columns of which exactly one is worth plotting; picking
 * the first for both axes draws nothing at all. So: classify first, choose
 * second, and never let Y land on X.
 */

export function isNumericColumn(column: ColumnDesc): boolean {
  return isNumericType(column.logical);
}

/** An identifier is a number that means nothing as a magnitude — it is orders
 *  larger than the real measure and flattens it onto the axis. */
export function isIdentifier(column: ColumnDesc): boolean {
  return /^id$|_id$|^uuid$/i.test(column.name);
}

/** A number that names a bucket rather than measuring one. */
const TIME_PART = /^(year|yr|quarter|qtr|month|mon|week|wk|day|dow|doy|hour|hr|minute|min|date|period|bucket)$/i;

/** Whatever a GROUP BY names is a dimension by construction. Handles the
 *  `GROUP BY 1, 2` form too, which points at output positions. */
export function groupedColumns(sql: string, columns: ColumnDesc[]): Set<string> {
  const out = new Set<string>();
  const m = /\bgroup\s+by\b([\s\S]*?)(?:\border\s+by\b|\bhaving\b|\blimit\b|\bwindow\b|$)/i.exec(sql);
  if (!m) return out;
  for (const part of m[1].split(",")) {
    const t = part.trim().replace(/;\s*$/, "");
    if (/^\d+$/.test(t)) {
      const c = columns[Number(t) - 1];
      if (c) out.add(c.name.toLowerCase());
      continue;
    }
    const name = t.split(/\s+/)[0]?.split(".").pop();
    if (name && /^[A-Za-z_][\w$]*$/.test(name)) out.add(name.toLowerCase());
  }
  return out;
}

/** The X axis when several dimensions share the rows: `2026 · 3`, rather than
 *  three rows all labelled `2026`. Parenthesised so no unquoted
 *  column name can be mistaken for it. */
export const COMBINED = "(combined)";

export interface ChartColumns {
  numericColumns: ColumnDesc[];
  dimensions: ColumnDesc[];
  measures: ColumnDesc[];
  /** A column name, or COMBINED for every dimension at once. */
  labelColumn: string | null;
  valueColumns: string[];
  /** The columns COMBINED stands for; empty unless labelColumn is COMBINED. */
  combinedOf: string[];
}

export function chooseColumns(
  columns: ColumnDesc[],
  rows: Cell[][],
  sql: string,
  chosenX: string | null | undefined,
  chosenY: string[] | null | undefined,
  maxSeries: number,
): ChartColumns {
  const numericColumns = columns.filter(isNumericColumn);
  const grouped = groupedColumns(sql, columns);
  const dimensions = columns.filter(
    (c) => !isNumericColumn(c) || isIdentifier(c) || TIME_PART.test(c.name) || grouped.has(c.name.toLowerCase()),
  );
  const measures = numericColumns.filter((c) => !dimensions.includes(c));

  // Only *buckets* combine. `year` and `month` together name one period, and
  // so do the columns of a GROUP BY; the dimensions of a raw `SELECT *` do
  // not — combining those gives one label per row, which is not an axis. And
  // only when a measure survives it: `GROUP BY 1, 2` with no aggregate is a
  // list, and folding its columns into the axis leaves nothing to plot.
  const buckets = dimensions.filter((c) => grouped.has(c.name.toLowerCase()) || TIME_PART.test(c.name));
  const combinable = buckets.length >= 2 && measures.length > 0 ? buckets.map((d) => d.name) : [];
  // Prefer a text column for the axis, then any dimension, then whatever came
  // first — a result of pure measures still has to be drawn.
  const first = columns.find((c) => !isNumericColumn(c)) ?? dimensions[0] ?? columns[0];
  const firstIndex = first ? columns.findIndex((c) => c.name === first.name) : -1;
  const repeats = firstIndex >= 0 && rows.length > 0 && new Set(rows.map((r) => String(r[firstIndex]))).size < rows.length;

  const labelColumn = chosenX ?? (combinable.length && repeats ? COMBINED : first?.name ?? null);
  const combinedOf = labelColumn === COMBINED ? combinable : [];
  const onX = new Set(labelColumn === COMBINED ? combinedOf : labelColumn ? [labelColumn] : []);

  // The Y default must never land on X: that filters the only series out and
  // the chart reads "nothing to plot" over a table full of numbers.
  const auto = measures.find((c) => !onX.has(c.name)) ?? numericColumns.find((c) => !onX.has(c.name));
  const valueColumns = (chosenY ?? (auto ? [auto.name] : [])).filter((n) => !onX.has(n)).slice(0, maxSeries);

  return { numericColumns, dimensions, measures, labelColumn, valueColumns, combinedOf };
}
