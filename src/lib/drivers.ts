import type { DriverKind } from "../ipc/types";

/** One tile in the driver picker. `driver` is set only for backends that exist. */
export interface DriverTile {
  id: string;
  label: string;
  mono: string; // two-letter monogram
  color: string; // badge fill — brand-ish, fixed across themes
  driver?: DriverKind;
  /** Default port to prefill. */
  port?: number;
}

export const DRIVERS: DriverTile[] = [
  { id: "postgres", label: "PostgreSQL", mono: "Pg", color: "#336791", driver: "postgres", port: 5432 },
  { id: "mysql", label: "MySQL", mono: "Ms", color: "#E48E00", driver: "mysql", port: 3306 },
  { id: "mariadb", label: "MariaDB", mono: "Ma", color: "#3C8E86", driver: "mysql", port: 3306 },
  { id: "sqlite", label: "SQLite", mono: "Sl", color: "#7C4DFF", driver: "sqlite" },
  { id: "redshift", label: "Amazon Redshift", mono: "Rs", color: "#3B5A9A" },
  { id: "mssql", label: "SQL Server", mono: "Ss", color: "#8E8E93" },
  { id: "mongo", label: "MongoDB", mono: "Mg", color: "#2E7D4F" },
  { id: "redis", label: "Redis", mono: "Re", color: "#C0392B" },
  { id: "clickhouse", label: "ClickHouse", mono: "Ch", color: "#C9A227" },
  { id: "duckdb", label: "DuckDB", mono: "Du", color: "#1B1A17" },
  { id: "cockroach", label: "CockroachDB", mono: "Cr", color: "#4CAF50" },
  { id: "bigquery", label: "BigQuery", mono: "Bq", color: "#4A7BD8" },
];

/** Tile to show for a saved profile (the badge in the connection list). */
export function tileFor(driver: DriverKind, port?: number): DriverTile {
  if (driver === "mysql" && port === 3306) return DRIVERS.find((d) => d.id === "mysql")!;
  return DRIVERS.find((d) => d.driver === driver) ?? DRIVERS[0];
}
