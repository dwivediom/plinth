import { toggleSafeMode } from "../app/actions";
import { useConnections } from "../state/connections";
import { useUi } from "../state/ui";
import { useWorkspaces } from "../state/workspaces";

/**
 * What to offer when the engine refuses a statement.
 *
 * A rail you cannot get past without leaving the app is a rail people route
 * around permanently — they open `psql` and stop using the client for
 * anything that matters. So every refusal carries its way through, and this
 * is the one place that decides which way, so the results row and a notice
 * never disagree.
 *
 * The three walls are not the same wall:
 *
 *   • **safe mode** — the padlock. It blocks every write, so it is always the
 *     first thing to clear; offering to elevate the policy while it is on
 *     leads to a second refusal.
 *   • **a read-only connection** — a promise about the connection, not a
 *     default to be talked out of. The way through is the settings, which is
 *     deliberate, persistent and visible.
 *   • **read-write refusing DDL** — the common case, and the one a single
 *     elevated run is for.
 */
export interface WayOut {
  label: string;
  run: () => void;
}

export function policyWayOut(workspaceId: string, refusal: string, retryElevated: () => void): WayOut | null {
  const w = useWorkspaces.getState().byId[workspaceId];
  if (!w) return null;

  if (w.safeMode || /safe mode/i.test(refusal)) {
    return { label: "Unlock safe mode", run: () => void toggleSafeMode() };
  }
  if (w.info.policy === "read-only" || /read-only policy/i.test(refusal)) {
    const profile = useConnections.getState().list.find((c) => c.id === w.info.connectionId) ?? null;
    if (!profile) return null;
    return {
      label: "Connection settings…",
      run: () => useUi.getState().setOverlay({ kind: "connection-sheet", profile, connectAfter: false }),
    };
  }
  return { label: "Run once anyway", run: retryElevated };
}
