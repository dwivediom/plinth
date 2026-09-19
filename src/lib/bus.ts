import { useEffect } from "react";

/** Tiny app event bus for commands that need a mounted component (focus, run, save…). */
export type BusEvents = {
  "focus-sidebar-search": void;
  "focus-quick-filter": void;
  "toggle-filter-bar": void;
  reload: void;
  save: void;
  cancel: void;
  beautify: void;
  run: { mode: "current" | "all" | "selection" };
  "new-row": void;
  "duplicate-row": void;
  "focus-editor": void;
};

type Handler<K extends keyof BusEvents> = (payload: BusEvents[K]) => void;
const handlers = new Map<keyof BusEvents, Set<Handler<keyof BusEvents>>>();

export const bus = {
  on<K extends keyof BusEvents>(name: K, fn: Handler<K>) {
    let set = handlers.get(name);
    if (!set) handlers.set(name, (set = new Set()));
    set.add(fn as Handler<keyof BusEvents>);
    return () => {
      set!.delete(fn as Handler<keyof BusEvents>);
    };
  },
  emit<K extends keyof BusEvents>(name: K, ...args: BusEvents[K] extends void ? [] : [BusEvents[K]]) {
    const set = handlers.get(name);
    if (!set) return false;
    for (const fn of Array.from(set)) fn(args[0] as BusEvents[K]);
    return set.size > 0;
  },
};

export function useBus<K extends keyof BusEvents>(name: K, fn: Handler<K>, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    return bus.on(name, fn);
  }, [name, fn, enabled]);
}
