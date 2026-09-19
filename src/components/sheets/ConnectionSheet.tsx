import { useState } from "react";
import { Check, ChevronDown, ChevronRight, CircleX } from "lucide-react";
import { errorMessage, invoke } from "../../ipc/client";
import type { ConnectionProfile, DriverKind, Environment, PolicyMode, SslMode, TestReport } from "../../ipc/types";
import { Sheet } from "../../components/common/Overlays";
import { useConnections } from "../../state/connections";
import { useUi } from "../../state/ui";
import { useWorkspaces } from "../../state/workspaces";
import { toast } from "../../state/overlays";

const blank = (): ConnectionProfile => ({
  id: "",
  name: "",
  driver: "postgres",
  environment: "local",
  policy: "read-write",
  statementTimeoutMs: defaultTimeout.local,
  host: "localhost",
  port: 5432,
  database: "",
  user: "",
  ssl: "prefer",
  hasPassword: false,
  favorite: false,
});

const defaultPort: Record<DriverKind, number> = { postgres: 5432, mysql: 3306, sqlite: 0 };

/**
 * A runaway `SELECT` on production is the reason people are told not to point a
 * GUI at it. The server-side timeout is the rail that actually stops one, so
 * production gets one by default — generous enough for real work, short enough
 * to not hold a lock for the afternoon.
 */
const defaultTimeout: Record<Environment, number | null> = { production: 30_000, staging: 60_000, local: null };

const timeoutOptions: [string, number | null][] = [
  ["No limit", null],
  ["5 seconds", 5_000],
  ["30 seconds", 30_000],
  ["1 minute", 60_000],
  ["5 minutes", 300_000],
];

export function ConnectionSheet({ profile, connectAfter, initialPassword = "" }: { profile: ConnectionProfile | null; connectAfter: boolean; initialPassword?: string }) {
  const close = useUi((s) => s.closeOverlay);
  const save = useConnections((s) => s.save);
  const launch = useWorkspaces((s) => s.launch);
  const [p, setP] = useState<ConnectionProfile>(profile ? { ...profile } : blank());
  const [password, setPassword] = useState(initialPassword);
  const [testing, setTesting] = useState(false);
  const [report, setReport] = useState<TestReport | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [timeoutTouched, setTimeoutTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const isNew = !profile || !profile.id;

  const set = <K extends keyof ConnectionProfile>(k: K, v: ConnectionProfile[K]) => setP((x) => ({ ...x, [k]: v }));
  const setEnvironment = (env: Environment) =>
    setP((x) => ({ ...x, environment: env, statementTimeoutMs: timeoutTouched ? x.statementTimeoutMs : defaultTimeout[env] }));
  const setDriver = (d: DriverKind) => setP((x) => ({ ...x, driver: d, port: d === "sqlite" ? undefined : defaultPort[d], ssl: d === "sqlite" ? "disable" : x.ssl }));

  const valid = p.name.trim() && (p.driver === "sqlite" ? !!p.filePath : !!p.host);

  const test = async () => {
    setTesting(true);
    setReport(null);
    try {
      setReport(await invoke("connection_test", { profile: p, password: password || null }));
    } catch (e) {
      setReport({ ok: false, stages: [{ name: "test", ok: false, durationMs: 0, error: errorMessage(e) }], serverVersion: null });
    } finally {
      setTesting(false);
    }
  };

  const submit = async (connect: boolean) => {
    if (!valid) return;
    setBusy(true);
    try {
      const saved = await save({ ...p, hasPassword: p.hasPassword || !!password }, password || null);
      close();
      // A new connection opens where every connection opens: its own window.
      if (connect) await launch(saved.id, saved.database || null);
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const pick = async () => {
    try {
      const path = await invoke("sqlite_pick_file", {});
      if (path) {
        set("filePath", path);
        if (!p.name) set("name", path.split("/").pop() ?? path);
      }
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  return (
    <Sheet onClose={close} width={500}>
      <h2>{isNew ? "New Connection" : `Edit “${profile?.name}”`}</h2>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(connectAfter || isNew);
        }}
      >
        <label htmlFor="c-name">Name</label>
        <div className="field">
          <input id="c-name" value={p.name} onChange={(e) => set("name", e.target.value)} placeholder="prod-rds" />
        </div>

        <label>Environment</label>
        <div className="row" role="radiogroup">
          {(["production", "staging", "local"] as Environment[]).map((env) => (
            <label key={env}>
              <input type="radio" name="env" checked={p.environment === env} onChange={() => setEnvironment(env)} />
              {env[0].toUpperCase() + env.slice(1)}
            </label>
          ))}
        </div>

        <label htmlFor="c-driver">Driver</label>
        <select id="c-driver" className="native" value={p.driver} onChange={(e) => setDriver(e.target.value as DriverKind)}>
          <option value="postgres">PostgreSQL</option>
          <option value="mysql">MySQL</option>
          <option value="sqlite">SQLite</option>
        </select>

        {p.driver === "sqlite" ? (
          <>
            <label htmlFor="c-file">File</label>
            <div className="row">
              <div className="field" style={{ flex: 1 }}>
                <input id="c-file" value={p.filePath ?? ""} onChange={(e) => set("filePath", e.target.value)} placeholder="~/Data/analytics.db" />
              </div>
              <button type="button" className="btn" onClick={() => void pick()}>
                Choose…
              </button>
            </div>
          </>
        ) : (
          <>
            <label htmlFor="c-host">Host</label>
            <div className="field">
              <input id="c-host" value={p.host ?? ""} onChange={(e) => set("host", e.target.value)} placeholder="db.example.com" />
            </div>
            <label htmlFor="c-port">Port</label>
            <div className="field" style={{ width: 80 }}>
              <input id="c-port" inputMode="numeric" value={p.port ?? ""} onChange={(e) => set("port", Number(e.target.value) || undefined)} />
            </div>
            <label htmlFor="c-db">Database</label>
            <div className="field" style={{ width: 180 }}>
              <input id="c-db" value={p.database ?? ""} onChange={(e) => set("database", e.target.value)} placeholder="app" />
            </div>
            <label htmlFor="c-user">User</label>
            <div className="field" style={{ width: 180 }}>
              <input id="c-user" value={p.user ?? ""} onChange={(e) => set("user", e.target.value)} />
            </div>
            <label htmlFor="c-pass">Password</label>
            <div className="row">
              <div className="field" style={{ flex: 1 }}>
                <input id="c-pass" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={p.hasPassword ? "•••••••• (saved)" : ""} />
              </div>
            </div>
            <label htmlFor="c-ssl">SSL</label>
            <select id="c-ssl" className="native" style={{ width: 120 }} value={p.ssl} onChange={(e) => set("ssl", e.target.value as SslMode)}>
              <option value="prefer">Prefer</option>
              <option value="require">Require</option>
              <option value="disable">Disable</option>
            </select>
          </>
        )}

        <button type="button" className="disc" style={{ textAlign: "left", display: "flex", alignItems: "center", gap: 4 }} onClick={() => setAdvanced((a) => !a)}>
          {advanced ? <ChevronDown /> : <ChevronRight />} Advanced <b>· {policyLabel(p.policy)}</b>
        </button>
        {advanced && (
          <>
            <label htmlFor="c-policy">Policy</label>
            <select id="c-policy" className="native" style={{ width: 180 }} value={p.policy} onChange={(e) => set("policy", e.target.value as PolicyMode)}>
              <option value="read-only">Read-only</option>
              <option value="read-write">Read / write</option>
              <option value="full">Full (incl. DDL)</option>
            </select>
            <label htmlFor="c-timeout">Statement timeout</label>
            <select
              id="c-timeout"
              className="native"
              style={{ width: 180 }}
              value={p.statementTimeoutMs ?? "none"}
              disabled={p.driver === "sqlite"}
              title={p.driver === "sqlite" ? "SQLite is a local file — nothing to time out" : "The server cancels a statement that runs longer than this"}
              onChange={(e) => {
                setTimeoutTouched(true);
                set("statementTimeoutMs", e.target.value === "none" ? null : Number(e.target.value));
              }}
            >
              {timeoutOptions.map(([label, ms]) => (
                <option key={label} value={ms ?? "none"}>
                  {label}
                </option>
              ))}
            </select>
            <label htmlFor="c-folder">Folder</label>
            <div className="field" style={{ width: 180 }}>
              <input id="c-folder" value={p.folder ?? ""} onChange={(e) => set("folder", e.target.value || undefined)} placeholder="Optional" />
            </div>
            <label htmlFor="c-color">Colour</label>
            <div className="row">
              <input id="c-color" type="color" value={p.color ?? "#8e8e93"} onChange={(e) => set("color", e.target.value)} />
              <label>
                <input type="checkbox" checked={p.favorite} onChange={(e) => set("favorite", e.target.checked)} /> Favourite
              </label>
            </div>
          </>
        )}
      </form>
      <div className="actions">
        <span className="left">
          <button type="button" className="btn" disabled={testing || !valid} onClick={() => void test()}>
            {testing ? "Testing…" : "Test"}
          </button>
          {report && (
            <span className="test-stages" aria-live="polite">
              <span className={`dot ${report.ok ? "g" : "r"}`} />
              {report.stages.map((s) => (
                <span key={s.name} className={`st ${s.ok ? "ok" : "fail"}`} title={s.error ?? undefined}>
                  {s.name} {s.ok ? <Check /> : <CircleX />}
                </span>
              ))}
              {report.ok && <span className="tertiary">· {report.stages.reduce((a, s) => a + s.durationMs, 0)} ms{report.serverVersion ? ` · ${report.serverVersion}` : ""}</span>}
              {!report.ok && <span className="error-text truncate" style={{ maxWidth: 200 }}>{report.stages.find((s) => !s.ok)?.error}</span>}
            </span>
          )}
        </span>
        <button type="button" className="btn" onClick={close}>
          Cancel
        </button>
        <button type="button" className="btn" disabled={!valid || busy} onClick={() => void submit(false)}>
          Save
        </button>
        <button type="button" className="btn default" disabled={!valid || busy} onClick={() => void submit(true)}>
          Connect
        </button>
      </div>
    </Sheet>
  );
}

function policyLabel(p: PolicyMode) {
  return p === "read-only" ? "Read-only" : p === "read-write" ? "Read / write" : "Full";
}
