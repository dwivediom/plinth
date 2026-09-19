import type { ConnectionProfile, DriverKind } from "../ipc/types";

export interface ParsedUrl {
  profile: Partial<ConnectionProfile> & { driver: DriverKind };
  password: string | null;
}

/**
 * Parse `postgres://user:pass@host:5432/db?sslmode=require`,
 * `mysql://…`, `sqlite:///absolute/path.db`, or a bare `/path/to/file.sqlite`.
 */
export function parseConnectionUrl(raw: string): ParsedUrl | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^\/|^~\//.test(s) || /\.(sqlite3?|db)$/i.test(s)) {
    return { profile: { driver: "sqlite", filePath: s, name: s.split("/").pop() ?? s, ssl: "disable" }, password: null };
  }
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  const scheme = u.protocol.replace(":", "").toLowerCase();
  let driver: DriverKind;
  if (["postgres", "postgresql", "pg"].includes(scheme)) driver = "postgres";
  else if (["mysql", "mariadb"].includes(scheme)) driver = "mysql";
  else if (["sqlite", "file"].includes(scheme)) {
    const path = decodeURIComponent(u.pathname);
    return { profile: { driver: "sqlite", filePath: path, name: path.split("/").pop() ?? path, ssl: "disable" }, password: null };
  } else return null;
  const sslParam = (u.searchParams.get("sslmode") ?? u.searchParams.get("ssl-mode") ?? "").toLowerCase();
  const ssl = sslParam.startsWith("require") || sslParam === "verify-ca" || sslParam === "verify-full" ? "require" : sslParam === "disable" ? "disable" : "prefer";
  const database = decodeURIComponent(u.pathname.replace(/^\//, "")) || undefined;
  const host = u.hostname || "localhost";
  return {
    profile: {
      driver,
      host,
      port: u.port ? Number(u.port) : driver === "postgres" ? 5432 : 3306,
      database,
      user: u.username ? decodeURIComponent(u.username) : undefined,
      ssl,
      name: `${host}${database ? " : " + database : ""}`,
      environment: /rds\.amazonaws|prod/i.test(host) ? "production" : /staging|stage/i.test(host) ? "staging" : "local",
    },
    password: u.password ? decodeURIComponent(u.password) : null,
  };
}
