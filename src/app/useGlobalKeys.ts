import { useEffect } from "react";
import { matches } from "../lib/keys";
import { useConfirm, useMenu, usePrompt } from "../state/overlays";
import { useUi } from "../state/ui";
import { actions } from "./actions";

const overlayOpeners: Record<string, string> = {
  "open-anything": "palette",
  "db-switcher": "db-switcher",
  "conn-switcher": "conn-switcher",
  "all-tabs": "all-tabs",
  shortcuts: "shortcuts",
  settings: "settings",
};

/** One capture-phase keydown listener that dispatches to `actions`. */
export function useGlobalKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      const ui = useUi.getState();
      const modal = useConfirm.getState().current || usePrompt.getState().current || useMenu.getState().open;
      for (const a of actions) {
        if (!a.chord || !matches(e, a.chord)) continue;
        if (modal) return;
        if (ui.overlay) {
          const opener = overlayOpeners[a.id];
          if (opener && ui.overlay.kind === opener) {
            e.preventDefault();
            ui.closeOverlay();
          }
          return;
        }
        if (a.when && !a.when()) continue;
        e.preventDefault();
        e.stopPropagation();
        a.run();
        return;
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);
}
