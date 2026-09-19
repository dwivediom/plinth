import { create } from "zustand";
import { errorMessage, invoke, subscribeEngineEvents } from "../ipc/client";
import type { ConsoleEntry } from "../ipc/types";
import { useWorkspaces } from "./workspaces";

interface ConsoleState {
  entries: ConsoleEntry[];
  loaded: boolean;
  loadError: string | null;
  load(): Promise<void>;
  append(e: ConsoleEntry): void;
  clear(): void;
}

export const useConsole = create<ConsoleState>((set) => ({
  entries: [],
  loaded: false,
  loadError: null,
  async load() {
    try {
      const entries = await invoke("console_list", { workspaceId: null, limit: 500 });
      set({ entries, loaded: true, loadError: null });
    } catch (e) {
      set({ loaded: true, loadError: errorMessage(e) || `unknown error: ${JSON.stringify(e)}` });
    }
  },
  append(e) {
    set((s) => (s.entries.some((x) => x.id === e.id) ? s : { entries: [...s.entries, e].slice(-1000) }));
  },
  clear: () => set({ entries: [] }),
}));

let wired = false;
/** Wire engine events into the stores. Idempotent. */
export function wireEngineEvents() {
  if (wired) return () => {};
  wired = true;
  const off = subscribeEngineEvents((ev) => {
    switch (ev.type) {
      case "console-appended":
        useConsole.getState().append(ev.entry);
        break;
      case "connection-state":
        useWorkspaces.getState().setConnState(ev.workspaceId, ev.state, ev.detail);
        break;
      case "schema-changed":
        void useWorkspaces.getState().loadSchema(ev.workspaceId, true);
        break;
    }
  });
  return () => {
    wired = false;
    off();
  };
}
