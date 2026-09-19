import { create } from "zustand";
import { errorMessage, invoke } from "../ipc/client";
import type { SchemaGraph } from "../ipc/types";

/**
 * One schema graph per workspace, shared by the map tab and the AI pane —
 * the same edges are drawn and walked, so what a person sees and what the
 * model is told can never disagree.
 */
interface GraphState {
  byWorkspace: Record<string, SchemaGraph>;
  loading: Record<string, boolean>;
  error: Record<string, string | null>;
  load(workspaceId: string, refresh?: boolean): Promise<SchemaGraph | null>;
  forget(workspaceId: string): void;
}

export const useGraph = create<GraphState>((set, get) => ({
  byWorkspace: {},
  loading: {},
  error: {},

  async load(workspaceId, refresh = false) {
    const existing = get().byWorkspace[workspaceId];
    if (existing && !refresh) return existing;
    if (get().loading[workspaceId]) return existing ?? null;
    set((s) => ({ loading: { ...s.loading, [workspaceId]: true }, error: { ...s.error, [workspaceId]: null } }));
    try {
      const graph = await invoke("schema_graph", { workspaceId, refresh });
      set((s) => ({ byWorkspace: { ...s.byWorkspace, [workspaceId]: graph } }));
      return graph;
    } catch (e) {
      set((s) => ({ error: { ...s.error, [workspaceId]: errorMessage(e) } }));
      return null;
    } finally {
      set((s) => ({ loading: { ...s.loading, [workspaceId]: false } }));
    }
  },

  forget(workspaceId) {
    set((s) => {
      const byWorkspace = { ...s.byWorkspace };
      delete byWorkspace[workspaceId];
      return { byWorkspace };
    });
  },
}));
