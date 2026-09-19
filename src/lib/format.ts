import type { Cell, ColumnDesc, DriverKind, Environment, LogicalType } from "../ipc/types";

const nf = new Intl.NumberFormat("en-US");

export function formatCount(n: number): string {
  return nf.format(n);
}

/** ~4.2M / 312k / 80 — for sidebar counts */
export function compactCount(n: number | null): string {
  if (n == null) return "";
  if (n >= 1_000_000) return `~${trim1(n / 1_000_000)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}
const trim1 = (x: number) => (Math.round(x * 10) / 10).toString();

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** 1h 12m style uptime */
export function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function relativeTime(iso: string | undefined | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const d = Date.now() - t;
  if (d < 60_000) return "just now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  if (d < 30 * 86_400_000) return `${Math.floor(d / 86_400_000)}d ago`;
  return new Date(t).toLocaleDateString();
}

export function timeOfDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

export const driverLabel: Record<DriverKind, string> = { postgres: "PostgreSQL", mysql: "MySQL", sqlite: "SQLite" };

export function envColor(env: Environment): string | null {
  if (env === "production") return "var(--red)";
  if (env === "staging") return "var(--orange)";
  return null;
}

/** Display text for a cell. Never coerces string-wire values through Number(). */
export function cellText(v: Cell, logical?: LogicalType): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  return logical === "json" || typeof v === "object" ? JSON.stringify(v) : String(v);
}

/** Text used when editing a cell (json gets pretty-printed). */
export function cellEditText(v: Cell, logical: LogicalType): string {
  if (v == null) return "";
  if (logical === "json" && typeof v === "object") return JSON.stringify(v, null, 2);
  return cellText(v, logical);
}

/** Parse editor text back into a wire value for the column. */
export function parseCellInput(text: string, col: ColumnDesc): { ok: true; value: Cell } | { ok: false; error: string } {
  switch (col.wire) {
    case "bool": {
      const t = text.trim().toLowerCase();
      if (["true", "t", "1", "yes"].includes(t)) return { ok: true, value: true };
      if (["false", "f", "0", "no"].includes(t)) return { ok: true, value: false };
      return { ok: false, error: "Expected true or false" };
    }
    case "number": {
      const t = text.trim();
      if (!/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(t)) return { ok: false, error: "Expected a number" };
      return { ok: true, value: Number(t) };
    }
    case "json": {
      try {
        return { ok: true, value: JSON.parse(text) as Cell };
      } catch {
        return { ok: false, error: "Invalid JSON" };
      }
    }
    default:
      return { ok: true, value: text };
  }
}

export function cellsEqual(a: Cell, b: Cell): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a === "object" || typeof b === "object") return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

export function truncateText(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
