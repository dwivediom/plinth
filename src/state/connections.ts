import { create } from "zustand";
import { errorMessage, invoke } from "../ipc/client";
import type { ConnectionProfile } from "../ipc/types";

interface ConnectionsState {
  list: ConnectionProfile[];
  loading: boolean;
  error: string | null;
  load(): Promise<void>;
  save(profile: ConnectionProfile, password?: string | null): Promise<ConnectionProfile>;
  remove(id: string): Promise<void>;
  byId(id: string): ConnectionProfile | undefined;
  /** Empty groups (folders with no connections yet), persisted in kv state. */
  groups: string[];
  addGroup(name: string): void;
}

export const useConnections = create<ConnectionsState>((set, get) => ({
  list: [],
  loading: false,
  error: null,
  groups: [],
  addGroup(name) {
    if (!name) return;
    set((s) => (s.groups.includes(name) ? s : { groups: [...s.groups, name] }));
    void invoke("state_set", { key: "connection-groups", value: get().groups }).catch(() => {});
  },
  async load() {
    set({ loading: true, error: null });
    try {
      const [list, groups] = await Promise.all([invoke("connections_list", {}), invoke("state_get", { key: "connection-groups" }).catch(() => null)]);
      set({ list, loading: false, groups: Array.isArray(groups) ? (groups as string[]) : [] });
    } catch (e) {
      set({ loading: false, error: errorMessage(e) });
    }
  },
  async save(profile, password) {
    const saved = await invoke("connections_save", { profile, password: password ?? null });
    set((s) => {
      const i = s.list.findIndex((c) => c.id === saved.id);
      const list = [...s.list];
      if (i >= 0) list[i] = saved;
      else list.push(saved);
      return { list };
    });
    return saved;
  },
  async remove(id) {
    await invoke("connections_delete", { id });
    set((s) => ({ list: s.list.filter((c) => c.id !== id) }));
  },
  byId: (id) => get().list.find((c) => c.id === id),
}));
