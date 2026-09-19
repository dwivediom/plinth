import type { Cell, ColumnDesc, TableRef } from "../ipc/types";

/**
 * Embeddings, made legible.
 *
 * A `vector(1536)` cell is 20 KB of digits nobody can read. Every other client
 * prints them anyway. We parse once and show what a person actually wants:
 * how many dimensions, how long the vector is, and a glance at its shape.
 */

export interface VectorStats {
  dims: number;
  /** Euclidean length. ≈1 means it was normalised, which is worth seeing. */
  norm: number;
  min: number;
  max: number;
  mean: number;
  values: number[];
}

/** pgvector text form: `[0.1,-0.2,…]`, or sparse `{1:0.5,4:0.2}/1536`. */
export function parseVector(cell: Cell): VectorStats | null {
  if (typeof cell !== "string") return null;
  const text = cell.trim();

  let values: number[] | null = null;
  let dims = 0;
  if (text.startsWith("[") && text.endsWith("]")) {
    const body = text.slice(1, -1);
    values = body ? body.split(",").map(Number) : [];
    dims = values.length;
  } else if (text.startsWith("{")) {
    // sparsevec: only the non-zero entries are listed, then /dims
    const slash = text.lastIndexOf("/");
    dims = slash > 0 ? Number(text.slice(slash + 1)) : 0;
    const body = text.slice(1, text.indexOf("}"));
    values = body ? body.split(",").map((pair) => Number(pair.split(":")[1])) : [];
  }
  if (!values || values.some((v) => !Number.isFinite(v))) return null;
  if (!values.length) return { dims, norm: 0, min: 0, max: 0, mean: 0, values: [] };

  let sum = 0;
  let sumSquares = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    sum += v;
    sumSquares += v * v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { dims: dims || values.length, norm: Math.sqrt(sumSquares), min, max, mean: sum / values.length, values };
}

export function isVector(column: ColumnDesc | { logical: string } | undefined): boolean {
  return column?.logical === "vector";
}

/**
 * A sparkline over the values, downsampled to the width available. Not a
 * chart — a fingerprint, so two rows can be told apart at a glance.
 */
export function sparkline(values: number[], width: number, height: number, buckets = 48): string {
  if (!values.length) return "";
  const step = Math.max(1, Math.floor(values.length / buckets));
  const points: number[] = [];
  for (let i = 0; i < values.length; i += step) {
    let peak = 0;
    for (let j = i; j < Math.min(i + step, values.length); j++) {
      if (Math.abs(values[j]) > Math.abs(peak)) peak = values[j];
    }
    points.push(peak);
  }
  const max = Math.max(...points.map(Math.abs)) || 1;
  const mid = height / 2;
  const dx = width / Math.max(1, points.length - 1);
  return points.map((v, i) => `${i ? "L" : "M"}${(i * dx).toFixed(1)},${(mid - (v / max) * mid * 0.9).toFixed(1)}`).join(" ");
}

export type Metric = "cosine" | "l2" | "inner";

export const METRICS: { id: Metric; label: string; op: string; hint: string }[] = [
  { id: "cosine", label: "Cosine", op: "<=>", hint: "Angle between vectors — the usual choice for embeddings" },
  { id: "l2", label: "Euclidean", op: "<->", hint: "Straight-line distance" },
  { id: "inner", label: "Inner product", op: "<#>", hint: "Negative inner product, for un-normalised vectors" },
];

/**
 * The query nobody wants to write by hand. Referencing the source row by key
 * rather than pasting 1,536 literals keeps it readable — and re-runnable.
 */
export function similaritySql(opts: {
  table: TableRef;
  column: string;
  keyColumn: string;
  keyValue: Cell;
  metric: Metric;
  limit: number;
  selectColumns?: string[];
  /** Ints and decimals arrive as strings on the wire, so the caller must say. */
  keyIsNumeric?: boolean;
}): string {
  const { table, column, keyColumn, keyValue, metric, limit } = opts;
  const name = table.schema ? `${table.schema}.${table.name}` : table.name;
  const op = METRICS.find((m) => m.id === metric)?.op ?? "<=>";
  const numeric = opts.keyIsNumeric || typeof keyValue === "number" || typeof keyValue === "boolean";
  const key = numeric ? String(keyValue) : `'${String(keyValue).replace(/'/g, "''")}'`;
  const select = opts.selectColumns?.length ? opts.selectColumns.map((c) => `t.${c}`).join(", ") : "t.*";
  const others = METRICS.filter((m) => m.id !== metric)
    .map((m) => `${m.op} ${m.label.toLowerCase()}`)
    .join(", ");
  return [
    `-- Nearest neighbours by ${METRICS.find((m) => m.id === metric)?.label.toLowerCase()} distance.`,
    `-- Swap the operator for another metric: ${others}.`,
    `SELECT ${select},`,
    `       t.${column} ${op} (SELECT ${column} FROM ${name} WHERE ${keyColumn} = ${key}) AS distance`,
    `FROM ${name} t`,
    `WHERE t.${keyColumn} <> ${key}`,
    `ORDER BY distance`,
    `LIMIT ${limit};`,
  ].join("\n");
}
