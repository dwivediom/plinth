import { useEffect, useState } from "react";
import { subscribeMenuEvents } from "./ipc/client";
import { actions, editorFocused } from "./app/actions";
import { useGlobalKeys } from "./app/useGlobalKeys";
import { Launcher } from "./components/launcher/Launcher";
import { WorkspaceView } from "./components/workspace/WorkspaceView";
import { ConfirmDialog, ContextMenu, PromptDialog, Toasts } from "./components/common/Overlays";
import { WriteGate } from "./components/common/WriteGate";
import { OverlayHost } from "./components/palette/OverlayHost";
import { useConnections } from "./state/connections";
import { useConsole, wireEngineEvents } from "./state/console";
import { useUi } from "./state/ui";
import { useWorkspaces } from "./state/workspaces";
import { initWindow, onWindowClose, setWindowTitle, windowIntent } from "./lib/windows";

export function App() {
  const [ready, setReady] = useState(false);
  const activeId = useWorkspaces((s) => s.activeId);
  const showLauncher = useUi((s) => s.showLauncher);
  const setWindowFocused = useUi((s) => s.setWindowFocused);
  useGlobalKeys();

  useEffect(() => {
    // Native menu → the same action table the keyboard uses.
    return subscribeMenuEvents((id) => {
      const a = actions.find((x) => x.id === id);
      if (!a) return;
      if (id === "toggle-inspector" && editorFocused()) {
        // ⌘I inside the editor means Beautify (the menu can't know focus).
        actions.find((x) => x.id === "beautify")?.run();
        return;
      }
      if (a.when && !a.when()) return;
      a.run();
    });
  }, []);
  useEffect(() => {
    const off = wireEngineEvents();
    void (async () => {
      // The window has to know which window it is before it can work out
      // which workspaces are its own.
      await initWindow();
      await Promise.all([useUi.getState().loadPrefs(), useConnections.getState().load(), useConsole.getState().load()]);
      await useWorkspaces.getState().bootstrap();
      // A window opened onto a connection connects itself, so it never shows
      // the launcher for a moment first.
      const intent = windowIntent();
      if (intent && !useWorkspaces.getState().activeId) {
        await useWorkspaces.getState().open(intent.connectionId, intent.database);
      }
      setReady(true);
    })();
    return off;
  }, []);

  // Closing a window hands its connections back; reloading it does not.
  useEffect(() => onWindowClose(() => useWorkspaces.getState().releaseAll()), []);

  // The title bar is hidden, but ⌘` and Mission Control still show the title.
  const titleFor = useWorkspaces((s) => {
    const w = s.activeId ? s.byId[s.activeId] : undefined;
    return w ? `${w.info.connectionName} — ${w.info.database}` : "Plinth";
  });
  useEffect(() => {
    void setWindowTitle(showLauncher ? "Plinth" : titleFor);
  }, [titleFor, showLauncher]);

  useEffect(() => {
    const sync = () => {
      const focused = document.hasFocus();
      setWindowFocused(focused);
      document.documentElement.classList.toggle("window-inactive", !focused);
    };
    sync();
    window.addEventListener("focus", sync);
    window.addEventListener("blur", sync);
    return () => {
      window.removeEventListener("focus", sync);
      window.removeEventListener("blur", sync);
    };
  }, [setWindowFocused]);

  // Block the browser's own context menu everywhere except editable fields.
  useEffect(() => {
    const onCtx = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, [contenteditable], .cm-editor")) return;
      e.preventDefault();
    };
    document.addEventListener("contextmenu", onCtx);
    return () => document.removeEventListener("contextmenu", onCtx);
  }, []);

  if (!ready) return <div className="app" />;

  return (
    <div className="app">
      {activeId && !showLauncher ? <WorkspaceView key={activeId} workspaceId={activeId} /> : <Launcher />}
      <OverlayHost />
      <ContextMenu />
      <ConfirmDialog />
      <WriteGate />
      <PromptDialog />
      <Toasts />
    </div>
  );
}
