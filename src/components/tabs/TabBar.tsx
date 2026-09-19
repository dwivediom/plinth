import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Menu, Plus, X } from "lucide-react";
import { closeTabWithConfirm } from "../../app/actions";
import { TabIcon } from "../../components/common/Icons";
import { envColor } from "../../lib/format";
import { chordLabel } from "../../lib/keys";
import { contextMenu, toast } from "../../state/overlays";
import { isTabDirty, type Tab } from "../../state/types";
import { useUi } from "../../state/ui";
import { useWorkspaces } from "../../state/workspaces";

export function TabBar({ workspaceId }: { workspaceId: string }) {
  const w = useWorkspaces((s) => s.byId[workspaceId]);
  const activateTab = useWorkspaces((s) => s.activateTab);
  const openQuery = useWorkspaces((s) => s.openQuery);
  const pinTab = useWorkspaces((s) => s.pinTab);
  const renameTab = useWorkspaces((s) => s.renameTab);
  const closeOthers = useWorkspaces((s) => s.closeOthers);
  const closeRight = useWorkspaces((s) => s.closeRight);
  const goBack = useWorkspaces((s) => s.goBack);
  const goForward = useWorkspaces((s) => s.goForward);
  const setOverlay = useUi((s) => s.setOverlay);
  const [renaming, setRenaming] = useState<string | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = stripRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    el?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [w?.activeTabId]);

  if (!w) return null;
  const env = envColor(w.info.environment);
  const canBack = w.back.some((id) => w.tabs.some((t) => t.id === id));
  const canFwd = w.forward.some((id) => w.tabs.some((t) => t.id === id));

  const menu = (t: Tab) => [
    { label: "Rename Tab…", shortcut: chordLabel("Mod+Shift+R"), onSelect: () => setRenaming(t.id) },
    { separator: true },
    { label: "Close Tab", shortcut: chordLabel("Mod+W"), onSelect: () => void closeTabWithConfirm(workspaceId, t.id) },
    { label: "Close Other Tabs", disabled: w.tabs.length < 2, onSelect: () => closeOthers(workspaceId, t.id) },
    { label: "Close Tabs to the Right", disabled: w.tabs.indexOf(t) === w.tabs.length - 1, onSelect: () => closeRight(workspaceId, t.id) },
    { separator: true },
    { label: t.preview ? "Pin Tab" : "Unpin Tab", onSelect: () => pinTab(workspaceId, t.id, t.preview) },
    { separator: true },
    t.kind === "table"
      ? { label: "Copy Table Name", onSelect: () => void navigator.clipboard.writeText(`${t.table.schema ? t.table.schema + "." : ""}${t.table.name}`).then(() => toast("Copied")) }
      : t.kind !== "query" && t.kind !== "saved"
        ? { label: "Copy Table Name", disabled: true, onSelect: () => {} }
        : { label: "Copy Query", onSelect: () => void navigator.clipboard.writeText(t.text).then(() => toast("Copied SQL")) },
  ].filter((i) => !("disabled" in i && i.disabled));

  return (
    <div className="tabbar" role="tablist" aria-label="Open tabs">
      <div className="nav">
        <button aria-label="Back" title={`Back ${chordLabel("Mod+[")}`} disabled={!canBack} onClick={() => goBack(workspaceId)}>
          <ChevronLeft />
        </button>
        <button aria-label="Forward" title={`Forward ${chordLabel("Mod+]")}`} disabled={!canFwd} onClick={() => goForward(workspaceId)}>
          <ChevronRight />
        </button>
      </div>
      <div className="tabs" ref={stripRef}>
        {w.tabs.map((t) => {
          const dirty = isTabDirty(t);
          const active = t.id === w.activeTabId;
          return (
            <div
              key={t.id}
              role="tab"
              aria-selected={active}
              className={`tab${t.preview ? " preview" : ""}`}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  void closeTabWithConfirm(workspaceId, t.id);
                } else if (e.button === 0) activateTab(workspaceId, t.id);
              }}
              onDoubleClick={() => {
                if (t.preview) pinTab(workspaceId, t.id, true);
                if (t.kind !== "table") setRenaming(t.id);
              }}
              onContextMenu={(e) => contextMenu(e, menu(t))}
              title={t.kind === "table" ? `${t.table.schema ?? ""}.${t.table.name}` : t.title}
            >
              {env && <span className="env" style={{ background: env }} />}
              <span className="ti">
                <TabIcon kind={t.kind} objectKind={t.kind === "table" ? t.objectKind : undefined} />
              </span>
              {renaming === t.id ? (
                <input
                  className="rename"
                  autoFocus
                  defaultValue={t.title}
                  onFocus={(e) => e.target.select()}
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v && v !== t.title) renameTab(workspaceId, t.id, v);
                    setRenaming(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    if (e.key === "Escape") setRenaming(null);
                  }}
                  onMouseDown={(e) => e.stopPropagation()}
                />
              ) : (
                <span className="t">{t.title}</span>
              )}
              <button
                className="close"
                aria-label={dirty ? "Unsaved changes — close tab" : "Close tab"}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  void closeTabWithConfirm(workspaceId, t.id);
                }}
              >
                {dirty && <span className="dirty" />}
                <span className="xi">
                  <X />
                </span>
              </button>
            </div>
          );
        })}
      </div>
      <button className="plus" title={`New Query ${chordLabel("Mod+T")}`} aria-label="New query tab" onClick={() => openQuery(workspaceId)}>
        <Plus />
      </button>
      <div className="right">
        <button className="icon-btn small" title={`Show All Tabs ${chordLabel("Mod+Shift+\\")}`} aria-label="Show all tabs" onClick={() => setOverlay({ kind: "all-tabs" })}>
          <Menu />
        </button>
      </div>
    </div>
  );
}
