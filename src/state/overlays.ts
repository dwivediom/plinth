import { create } from "zustand";

// ───────────────────────── context menu ─────────────────────────

export interface MenuItem {
  label?: string;
  shortcut?: string;
  disabled?: boolean;
  destructive?: boolean;
  checked?: boolean;
  separator?: boolean;
  onSelect?: () => void;
}

interface MenuState {
  open: { x: number; y: number; items: MenuItem[] } | null;
  show(x: number, y: number, items: MenuItem[]): void;
  hide(): void;
}

export const useMenu = create<MenuState>((set) => ({
  open: null,
  show: (x, y, items) => set({ open: { x, y, items } }),
  hide: () => set({ open: null }),
}));

/** Convenience for onContextMenu handlers. */
export function contextMenu(e: { preventDefault(): void; stopPropagation(): void; clientX: number; clientY: number }, items: MenuItem[]) {
  e.preventDefault();
  e.stopPropagation();
  useMenu.getState().show(e.clientX, e.clientY, items);
}

// ───────────────────────── confirm dialog ─────────────────────────

export interface ConfirmButton<T extends string = string> {
  label: string;
  value: T;
  role?: "default" | "cancel" | "destructive";
}
export interface ConfirmRequest<T extends string = string> {
  title: string;
  message?: string;
  buttons: ConfirmButton<T>[];
}

interface ConfirmState {
  current: (ConfirmRequest & { resolve: (v: string) => void }) | null;
  ask<T extends string>(req: ConfirmRequest<T>): Promise<T>;
  answer(v: string): void;
}

export const useConfirm = create<ConfirmState>((set, get) => ({
  current: null,
  ask<T extends string>(req: ConfirmRequest<T>) {
    return new Promise<T>((resolve) => {
      set({ current: { ...(req as ConfirmRequest), resolve: (v) => resolve(v as T) } });
    });
  },
  answer(v) {
    const c = get().current;
    set({ current: null });
    c?.resolve(v);
  },
}));

export const confirm = <T extends string>(req: ConfirmRequest<T>) => useConfirm.getState().ask(req);

// ───────────────────────── prompt (single text field) ─────────────────────────

interface PromptState {
  current: { title: string; initial: string; placeholder?: string; resolve: (v: string | null) => void } | null;
  ask(title: string, initial?: string, placeholder?: string): Promise<string | null>;
  answer(v: string | null): void;
}
export const usePrompt = create<PromptState>((set, get) => ({
  current: null,
  ask(title, initial = "", placeholder) {
    return new Promise((resolve) => set({ current: { title, initial, placeholder, resolve } }));
  },
  answer(v) {
    const c = get().current;
    set({ current: null });
    c?.resolve(v);
  },
}));
export const prompt = (title: string, initial?: string, placeholder?: string) => usePrompt.getState().ask(title, initial, placeholder);

// ───────────────────── the write gate ─────────────────────

/**
 * The dialog that stands between a destructive statement and the database.
 *
 * It is its own thing rather than a `confirm()` because it has to show the
 * statement itself, and because the serious tier asks you to type the table's
 * name — a Yes button is a reflex, typing is a decision.
 */
export interface WriteGateRequest {
  /** "Delete from orders?" */
  title: string;
  /** One line: what it does, and how much of it. */
  detail: string;
  /** The exact statements that will be sent. */
  statements: string[];
  /** Non-null for the serious tier: the word that has to be typed. */
  confirmWord: string | null;
  /** The label on the button that goes ahead. */
  verb: string;
  severity: "warn" | "danger";
}

interface WriteGateState {
  current: (WriteGateRequest & { resolve: (ok: boolean) => void }) | null;
  ask(req: WriteGateRequest): Promise<boolean>;
  answer(ok: boolean): void;
}

export const useWriteGate = create<WriteGateState>((set, get) => ({
  current: null,
  ask(req) {
    return new Promise<boolean>((resolve) => set({ current: { ...req, resolve } }));
  },
  answer(ok) {
    const c = get().current;
    set({ current: null });
    c?.resolve(ok);
  },
}));

export const askWriteGate = (req: WriteGateRequest) => useWriteGate.getState().ask(req);

// ───────────────────────── toasts ─────────────────────────

export interface Toast {
  id: number;
  text: string;
  kind: "info" | "error";
  /**
   * What to do about it.
   *
   * A notice that tells you what went wrong and leaves you to find the fix is
   * half a message. Where there is an obvious next step — unlock the padlock,
   * run it once anyway, open the settings — it belongs on the notice.
   */
  action?: { label: string; run: () => void };
}
interface ToastState {
  toasts: Toast[];
  push(text: string, kind?: Toast["kind"], action?: Toast["action"]): void;
  dismiss(id: number): void;
}
let toastSeq = 1;
export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push(text, kind = "info", action) {
    const id = toastSeq++;
    set((s) => ({ toasts: [...s.toasts, { id, text, kind, action }] }));
    // One that offers something to do waits longer: it is asking a question,
    // not reporting a fact, and three seconds is not long enough to read it
    // and decide.
    const ms = action ? 12_000 : kind === "error" ? 6000 : 3000;
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ms);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
export const toast = (text: string, kind: Toast["kind"] = "info", action?: Toast["action"]) => useToasts.getState().push(text, kind, action);
