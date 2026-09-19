import { invoke, isTauri } from "../ipc/client";

/**
 * Windows.
 *
 * One process, one engine, many windows. A window owns the connections it has
 * open and the tabs inside them; everything else — the connection list, the
 * console, saved queries, the AI — belongs to the application and is the same
 * in every window.
 *
 * The identity of a window is its label. In the app it is Tauri's; in a
 * browser it is a per-tab id, so `npm run dev` exercises the same code paths
 * with two tabs instead of two windows.
 */

let label = "main";
let ready = false;

/** Resolve this window's identity. Call once, before anything reads it. */
export async function initWindow(): Promise<string> {
  if (ready) return label;
  if (isTauri) {
    try {
      const m = await import("@tauri-apps/api/window");
      label = m.getCurrentWindow().label;
    } catch {
      label = "main";
    }
  } else {
    const key = "plinth:window";
    let l = sessionStorage.getItem(key);
    if (!l) {
      l = `b${Math.random().toString(36).slice(2, 7)}`;
      sessionStorage.setItem(key, l);
    }
    label = l;
  }
  ready = true;
  return label;
}

export const windowLabel = () => label;
export const isMainWindow = () => label === "main";

/** What this window was opened to show, if anything. */
export function windowIntent(): { connectionId: string; database: string | null } | null {
  if (typeof location === "undefined") return null;
  const p = new URLSearchParams(location.search);
  const connectionId = p.get("open");
  if (!connectionId) return null;
  return { connectionId, database: p.get("db") };
}

/**
 * Open another window, optionally straight onto a connection. The intent
 * travels in the URL so the new window connects on its own: there is no
 * moment where it sits on the launcher and then jumps.
 */
export async function openWindow(intent?: { connectionId: string; database?: string | null }): Promise<boolean> {
  if (isTauri) {
    await invoke("window_open", { open: intent?.connectionId ?? null, database: intent?.database ?? null, from: label });
    return true;
  }
  // In the browser a real second window is the honest equivalent, and it gets
  // its own tab id, so ownership behaves as it does in the app. A blocked
  // popup returns null, and the caller falls back to opening here.
  const q = intent ? `?open=${encodeURIComponent(intent.connectionId)}${intent.database ? `&db=${encodeURIComponent(intent.database)}` : ""}` : "";
  return !!window.open(`${location.pathname}${q}`, "_blank", "noopener,width=1180,height=760");
}

/** Close this window. The close handler hands its connections back first. */
export async function closeWindow(): Promise<void> {
  if (!isTauri) {
    window.close();
    return;
  }
  const m = await import("@tauri-apps/api/window");
  await m.getCurrentWindow().close();
}

/** Bring a window forward. False when it has gone. */
export async function focusWindow(target: string): Promise<boolean> {
  if (!isTauri) return false;
  try {
    return await invoke("window_focus", { label: target });
  } catch {
    return false;
  }
}

/** The labels that actually exist right now — a registry entry can outlive its window. */
export async function liveWindows(): Promise<string[]> {
  if (!isTauri) return [label];
  try {
    return await invoke("window_list", {});
  } catch {
    return [label];
  }
}

/** The title bar is hidden, but the title is what ⌘` and Mission Control show. */
export async function setWindowTitle(title: string): Promise<void> {
  if (!isTauri) {
    document.title = title;
    return;
  }
  try {
    const m = await import("@tauri-apps/api/window");
    await m.getCurrentWindow().setTitle(title);
  } catch {
    /* a title is not worth an error */
  }
}

/**
 * Run `fn` when this window is closing — not when it reloads.
 *
 * `beforeunload` cannot tell the two apart, and treating a ⌘R as a close
 * would drop the connection every time someone reloaded.
 */
export function onWindowClose(fn: () => Promise<void> | void): () => void {
  // A browser page cannot tell a reload from a close either, and its mock
  // engine dies with the page, so there is nothing to hand back.
  if (!isTauri) return () => {};
  let un: (() => void) | null = null;
  let disposed = false;
  void import("@tauri-apps/api/window").then(async (m) => {
    const w = m.getCurrentWindow();
    const off = await w.onCloseRequested(async (e) => {
      // Hold the close until the workspaces are handed back, then let it go.
      e.preventDefault();
      try {
        await fn();
      } finally {
        await w.destroy();
      }
    });
    if (disposed) off();
    else un = off;
  });
  return () => {
    disposed = true;
    un?.();
  };
}
