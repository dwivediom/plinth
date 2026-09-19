import { useCallback, useMemo } from "react";
import { ArrowLeftRight, Bookmark, Command, Database, ScrollText, Server } from "lucide-react";
import { actions } from "../../app/actions";
import { ObjectIcon, TabIcon } from "../../components/common/Icons";
import { ConnectionSheet } from "../../components/sheets/ConnectionSheet";
import { DriverPicker } from "../../components/launcher/DriverPicker";
import { Guide } from "../../components/guide/Guide";
import { JsonScratch } from "../../components/json/JsonScratch";
import { JsonZoom } from "../../components/json/JsonZoom";
import { SettingsSheet } from "../../components/sheets/SettingsSheet";
import { ShortcutsSheet } from "../../components/sheets/ShortcutsSheet";
import { envColor } from "../../lib/format";
import { chordLabel, isMac } from "../../lib/keys";
import { useConnections } from "../../state/connections";
import { useSaved } from "../../state/saved";
import { useUi } from "../../state/ui";
import { useWorkspaces } from "../../state/workspaces";
import { ListPalette, type PaletteItem } from "./ListPalette";

export function OverlayHost() {
  const overlay = useUi((s) => s.overlay);
  const close = useUi((s) => s.closeOverlay);
  const onClose = useCallback(() => close(), [close]);
  if (!overlay) return null;
  switch (overlay.kind) {
    case "palette":
      return <OpenAnything onClose={onClose} />;
    case "db-switcher":
      return <DbSwitcher onClose={onClose} />;
    case "conn-switcher":
      return <ConnSwitcher onClose={onClose} />;
    case "all-tabs":
      return <AllTabs onClose={onClose} />;
    case "shortcuts":
      return <ShortcutsSheet />;
    case "guide":
      return <Guide />;
    case "json-scratch":
      return <JsonScratch />;
    case "json-zoom":
      return <JsonZoom text={overlay.text} title={overlay.title} sqlColumn={overlay.sqlColumn ?? null} />;
    case "settings":
      return <SettingsSheet />;
    case "driver-picker":
      return <DriverPicker />;
    case "connection-sheet":
      return <ConnectionSheet profile={overlay.profile} connectAfter={overlay.connectAfter} initialPassword={overlay.password ?? ""} />;
  }
}

const anchor = () => ({ left: useUi.getState().sidebarVisible ? Math.min(130, useUi.getState().sidebarWidth - 60) : 16, top: 46, width: 300 });

function EnvDot({ env }: { env: "local" | "staging" | "production" }) {
  const c = envColor(env);
  return <span className={`env${c ? "" : " none"}`} style={{ background: c ?? undefined }} />;
}

export function DbSwitcher({ onClose }: { onClose: () => void }) {
  const w = useWorkspaces((s) => (s.activeId ? s.byId[s.activeId] : undefined));
  const all = useWorkspaces((s) => s.byId);
  const launch = useWorkspaces((s) => s.launch);
  const items = useMemo<PaletteItem[]>(() => {
    if (!w) return [];
    return w.info.databases.map((db) => {
      const openWs = Object.values(all).find((x) => x.info.connectionId === w.info.connectionId && x.info.database === db);
      const current = openWs?.info.id === w.info.id;
      return {
        id: db,
        label: db,
        icon: <Database />,
        kbd: current ? "current" : openWs ? "open" : undefined,
        onSelect: () => {
          if (current) return;
          void launch(w.info.connectionId, db);
        },
      };
    });
  }, [w, all, launch]);
  if (!w) return null;
  return <ListPalette anchor={anchor()} placeholder="Switch database" items={items} keepOrder onClose={onClose} hint={<><span>⏎ opens it in its own window</span></>} />;
}

export function ConnSwitcher({ onClose }: { onClose: () => void }) {
  const list = useConnections((s) => s.list);
  const all = useWorkspaces((s) => s.byId);
  const launch = useWorkspaces((s) => s.launch);
  const setOverlay = useUi((s) => s.setOverlay);
  const items = useMemo<PaletteItem[]>(() => {
    const out: PaletteItem[] = list.map((c) => {
      const openWs = Object.values(all).find((x) => x.info.connectionId === c.id);
      return {
        id: c.id,
        label: c.name,
        icon: <EnvDot env={c.environment} />,
        detail: c.driver === "sqlite" ? "SQLite" : `${c.host ?? ""}`,
        kbd: openWs ? "open" : undefined,
        onSelect: () => void launch(c.id, c.database ?? null),
      };
    });
    out.push({ id: "__new", label: "New Connection…", icon: <Server />, onSelect: () => setOverlay({ kind: "driver-picker" }) });
    return out;
  }, [list, all, launch, setOverlay]);
  return <ListPalette anchor={anchor()} placeholder="Switch connection" items={items} keepOrder onClose={onClose} hint={<><span>⏎ opens it in its own window</span></>} />;
}

export function AllTabs({ onClose }: { onClose: () => void }) {
  const w = useWorkspaces((s) => (s.activeId ? s.byId[s.activeId] : undefined));
  const activate = useWorkspaces((s) => s.activateTab);
  const items = useMemo<PaletteItem[]>(
    () =>
      (w?.tabs ?? []).map((t, i) => ({
        id: t.id,
        label: t.title,
        icon: <TabIcon kind={t.kind} objectKind={t.kind === "table" ? t.objectKind : undefined} />,
        detail: t.kind === "table" ? `${t.table.schema ?? ""}.${t.table.name}` : t.kind === "saved" ? "saved query" : "query",
        kbd: i < 9 ? chordLabel(`Mod+${i + 1}`) : undefined,
        onSelect: () => w && activate(w.info.id, t.id),
      })),
    [w, activate],
  );
  return <ListPalette placeholder="Switch to tab" items={items} keepOrder onClose={onClose} emptyText="No open tabs" />;
}

export function OpenAnything({ onClose }: { onClose: () => void }) {
  const w = useWorkspaces((s) => (s.activeId ? s.byId[s.activeId] : undefined));
  const all = useWorkspaces((s) => s.byId);
  const openObject = useWorkspaces((s) => s.openObject);
  const openSaved = useWorkspaces((s) => s.openSaved);
  const launch = useWorkspaces((s) => s.launch);
  const setActive = useWorkspaces((s) => s.setActive);
  const connections = useConnections((s) => s.list);
  const saved = useSaved((s) => s.list);

  const items = useMemo<PaletteItem[]>(() => {
    const out: PaletteItem[] = [];
    if (w?.schema) {
      for (const s of w.schema.schemas) {
        if (s.isSystem) continue;
        for (const o of s.objects) {
          out.push({
            id: `obj:${s.name}.${o.name}`,
            group: "Tables & views",
            label: o.name,
            keywords: `${s.name}.${o.name}`,
            detail: `${o.kind === "table" ? "Open Table" : o.kind === "view" || o.kind === "materialized-view" ? "Open View" : "Open"} · ${s.name}.${o.name}`,
            icon: <ObjectIcon kind={o.kind} />,
            onSelect: (m) => openObject(w.info.id, o, { newTab: m.mod, pin: m.mod }),
          });
        }
      }
    }
    for (const q of saved.filter((q) => !w || q.connectionId == null || q.connectionId === w.info.connectionId)) {
      out.push({ id: `sq:${q.id}`, group: "Saved queries", label: q.name, detail: "Run Saved Query", icon: <Bookmark />, onSelect: (m) => w && openSaved(w.info.id, q, { newTab: m.mod, pin: m.mod }) });
    }
    if (w) {
      for (const db of w.info.databases) {
        if (db === w.info.database) continue;
        const openWs = Object.values(all).find((x) => x.info.connectionId === w.info.connectionId && x.info.database === db);
        out.push({ id: `db:${db}`, group: "Databases", label: db, detail: openWs ? "Bring its window forward" : "Open Database", icon: <Database />, onSelect: () => void launch(w.info.connectionId, db) });
      }
    }
    for (const c of connections) {
      const openWs = Object.values(all).find((x) => x.info.connectionId === c.id);
      out.push({ id: `conn:${c.id}`, group: "Connections", label: c.name, detail: openWs ? "Bring its window forward" : "Connect", icon: <ArrowLeftRight />, onSelect: () => void launch(c.id, c.database ?? null) });
    }
    for (const a of actions) {
      if (a.palette === false) continue;
      out.push({ id: `cmd:${a.id}`, group: "Commands", label: a.label, icon: <Command />, kbd: a.chord ? chordLabel(a.chord) : undefined, onSelect: () => a.run() });
    }
    return out;
  }, [w, all, saved, connections, openObject, openSaved, launch, setActive]);

  return (
    <ListPalette
      placeholder="Open Anything"
      items={items}
      onClose={onClose}
      hint={
        <>
          <span>⏎ open</span>
          <span>{isMac ? "⌘⏎" : "Ctrl+⏎"} open in new tab</span>
          <span className="spacer" />
          <ScrollText style={{ width: 11, height: 11 }} /> <span>type a query name, table or command</span>
        </>
      }
    />
  );
}
