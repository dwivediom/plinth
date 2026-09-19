import type { CommandName, Commands, EngineEvent } from "./types";
import { ENGINE_EVENT } from "./types";

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

type Args<K extends CommandName> = Parameters<Commands[K]>[0];
type Ret<K extends CommandName> = ReturnType<Commands[K]>;

let mockPromise: Promise<typeof import("./mock")> | null = null;
const loadMock = () => (mockPromise ??= import("./mock"));

/** Typed IPC entry point. Tauri in the app, the in-memory mock in a plain browser. */
export function invoke<K extends CommandName>(cmd: K, args: Args<K>): Ret<K> {
  if (isTauri) {
    return import("@tauri-apps/api/core").then((m) => m.invoke(cmd, args as Record<string, unknown>)) as Ret<K>;
  }
  return loadMock().then((m) => (m.mock[cmd] as unknown as (a: Args<K>) => Promise<unknown>)(args)) as unknown as Ret<K>;
}

export type Unsubscribe = () => void;

/** Subscribe to engine events. Returns an unsubscribe function. */
export function subscribeEngineEvents(cb: (ev: EngineEvent) => void): Unsubscribe {
  let disposed = false;
  let off: Unsubscribe | null = null;
  if (isTauri) {
    import("@tauri-apps/api/event").then(async (m) => {
      const un = await m.listen<EngineEvent>(ENGINE_EVENT, (e) => cb(e.payload));
      if (disposed) un();
      else off = un;
    });
  } else {
    loadMock().then((m) => {
      const un = m.mockEmitter.subscribe(cb);
      if (disposed) un();
      else off = un;
    });
  }
  return () => {
    disposed = true;
    off?.();
  };
}

/** Normalise whatever the transport threw into a readable message. */
export function errorMessage(e: unknown): string {
  if (!e) return "Unknown error";
  if (typeof e === "string") return e;
  if (typeof e === "object") {
    const o = e as { message?: unknown; detail?: unknown };
    if (typeof o.message === "string") return o.detail && typeof o.detail === "string" ? `${o.message} — ${o.detail}` : o.message;
  }
  return String(e);
}

/**
 * Native menu items (Tauri emits `plinth://menu` with the action id).
 * On macOS AppKit consumes the key equivalent before the webview sees it,
 * so menu events are the only way those chords reach us.
 */
export function subscribeMenuEvents(cb: (actionId: string) => void): Unsubscribe {
  if (!isTauri) return () => {};
  let disposed = false;
  let off: Unsubscribe | null = null;
  import("@tauri-apps/api/event").then(async (m) => {
    const un = await m.listen<string>("plinth://menu", (e) => cb(e.payload));
    if (disposed) un();
    else off = un;
  });
  return () => {
    disposed = true;
    off?.();
  };
}
