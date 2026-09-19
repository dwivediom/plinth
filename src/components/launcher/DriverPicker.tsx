import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import type { ConnectionProfile } from "../../ipc/types";
import { Sheet } from "../common/Overlays";
import { DRIVERS, type DriverTile } from "../../lib/drivers";
import { parseConnectionUrl } from "../../lib/connUrl";
import { prompt, toast } from "../../state/overlays";
import { useConnections } from "../../state/connections";
import { useUi } from "../../state/ui";

const base = (): ConnectionProfile => ({
  id: "",
  name: "",
  driver: "postgres",
  environment: "local",
  policy: "read-write",
  host: "localhost",
  database: "",
  user: "",
  ssl: "prefer",
  hasPassword: false,
  favorite: false,
});

/** The first step of "New Connection": pick a database, TablePlus-style. */
export function DriverPicker() {
  const close = useUi((s) => s.closeOverlay);
  const setOverlay = useUi((s) => s.setOverlay);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<string>(DRIVERS[0].id);
  const inputRef = useRef<HTMLInputElement>(null);

  const tiles = useMemo(() => {
    const t = q.trim().toLowerCase();
    return DRIVERS.filter((d) => !t || d.label.toLowerCase().includes(t) || d.id.includes(t));
  }, [q]);
  useEffect(() => {
    if (!tiles.some((t) => t.id === sel)) setSel(tiles[0]?.id ?? "");
  }, [tiles, sel]);

  const create = (tile: DriverTile | undefined) => {
    if (!tile?.driver) return;
    const p = base();
    p.driver = tile.driver;
    p.port = tile.port;
    if (tile.driver === "sqlite") {
      p.host = undefined;
      p.ssl = "disable";
    }
    setOverlay({ kind: "connection-sheet", profile: p, connectAfter: true });
  };

  const importUrl = async () => {
    const url = await prompt("Import Connection — paste a URL (postgres://user:pass@host/db, mysql://…, or a SQLite path)", "", "postgres://…");
    if (!url) return;
    const parsed = parseConnectionUrl(url);
    if (!parsed) {
      toast("That doesn't look like a connection URL.", "error");
      return;
    }
    const p = { ...base(), ...parsed.profile } as ConnectionProfile;
    setOverlay({ kind: "connection-sheet", profile: p, connectAfter: true, password: parsed.password });
  };

  const newGroup = async () => {
    const name = await prompt("New Group", "", "Production");
    if (!name) return;
    useConnections.getState().addGroup(name.trim());
    close();
  };

  const onKey = (e: React.KeyboardEvent) => {
    const cols = 6;
    const i = tiles.findIndex((t) => t.id === sel);
    const move = (n: number) => {
      const j = Math.max(0, Math.min(tiles.length - 1, i + n));
      setSel(tiles[j]?.id ?? sel);
    };
    if (e.key === "ArrowRight") { e.preventDefault(); move(1); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); move(-1); }
    else if (e.key === "ArrowDown") { e.preventDefault(); move(cols); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(-cols); }
    else if (e.key === "Enter") { e.preventDefault(); create(tiles.find((t) => t.id === sel)); }
  };

  const selected = tiles.find((t) => t.id === sel);

  return (
    <Sheet onClose={close} width={720} className="driver-picker">
      <div onKeyDown={onKey}>
        <div className="field" style={{ marginBottom: "var(--sp-6)" }}>
          <span className="glyph"><Search /></span>
          <input ref={inputRef} placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search databases" autoFocus />
        </div>
        <div className="driver-grid" role="listbox" aria-label="Database type">
          {tiles.map((t) => (
            <button
              key={t.id}
              type="button"
              role="option"
              aria-selected={sel === t.id}
              className={`driver-tile${t.driver ? "" : " soon"}`}
              onClick={() => setSel(t.id)}
              onDoubleClick={() => create(t)}
              title={t.driver ? t.label : `${t.label} — coming later`}
            >
              <span className="badge" style={{ background: t.color }}>{t.mono}</span>
              <span className="lbl">{t.label}</span>
              {!t.driver && <span className="soon-tag">Soon</span>}
            </button>
          ))}
          {!tiles.length && <div className="empty" style={{ gridColumn: "1 / -1" }}>No database matches “{q}”</div>}
        </div>
        <div className="actions">
          <button className="btn" onClick={close}>Cancel</button>
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={() => void importUrl()}>Import Connection</button>
          <button className="btn" onClick={() => void newGroup()}>New Group</button>
          <button className="btn default" disabled={!selected?.driver} onClick={() => create(selected)}>Create</button>
        </div>
      </div>
    </Sheet>
  );
}
