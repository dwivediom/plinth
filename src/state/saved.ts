import { create } from "zustand";
import { invoke } from "../ipc/client";
import type { SavedQuery } from "../ipc/types";

interface SavedState {
  list: SavedQuery[];
  loaded: boolean;
  load(): Promise<void>;
  save(q: SavedQuery): Promise<SavedQuery>;
  remove(id: string): Promise<void>;
}

export const useSaved = create<SavedState>((set) => ({
  list: [],
  loaded: false,
  async load() {
    try {
      const list = await invoke("saved_list", {});
      set({ list, loaded: true });
    } catch {
      set({ loaded: true });
    }
  },
  async save(q) {
    const saved = await invoke("saved_save", { query: q });
    set((s) => {
      const i = s.list.findIndex((x) => x.id === saved.id);
      const list = [...s.list];
      if (i >= 0) list[i] = saved;
      else list.push(saved);
      return { list };
    });
    return saved;
  },
  async remove(id) {
    await invoke("saved_delete", { id });
    set((s) => ({ list: s.list.filter((x) => x.id !== id) }));
  },
}));
