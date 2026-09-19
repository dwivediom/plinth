/** Keyboard helpers. `Mod` is ⌘ on macOS and Ctrl elsewhere. */
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

type AnyKey = KeyboardEvent | ReactKeyboardEvent;

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export function isMod(e: AnyKey): boolean {
  return isMac ? e.metaKey : e.ctrlKey;
}

/**
 * Match a chord string like "Mod+Shift+K", "Ctrl+Tab", "Mod+Enter", "Escape".
 * Modifier names: Mod, Ctrl, Alt, Shift.
 */
export function matches(e: AnyKey, chord: string): boolean {
  const parts = chord.split("+");
  const key = parts.pop()!;
  const want = { mod: false, ctrl: false, alt: false, shift: false };
  for (const p of parts) {
    if (p === "Mod") want.mod = true;
    else if (p === "Ctrl") want.ctrl = true;
    else if (p === "Alt") want.alt = true;
    else if (p === "Shift") want.shift = true;
  }
  if (isMac) {
    if (e.metaKey !== want.mod) return false;
    if (e.ctrlKey !== want.ctrl) return false;
  } else {
    if (e.metaKey) return false;
    if (e.ctrlKey !== (want.mod || want.ctrl)) return false;
  }
  if (e.altKey !== want.alt) return false;
  if (e.shiftKey !== want.shift) return false;
  return keyMatches(e, key);
}

function keyMatches(e: AnyKey, key: string): boolean {
  const k = e.key;
  const code = e.code;
  switch (key) {
    case "Enter":
      return k === "Enter";
    case "Escape":
      return k === "Escape";
    case "Tab":
      return k === "Tab";
    case "Backspace":
      return k === "Backspace";
    case "Delete":
      return k === "Delete";
    case "ArrowUp":
    case "ArrowDown":
    case "ArrowLeft":
    case "ArrowRight":
      return k === key;
    case "[":
      return k === "[" || code === "BracketLeft";
    case "]":
      return k === "]" || code === "BracketRight";
    case "\\":
      return k === "\\" || code === "Backslash";
    case "/":
      return k === "/" || code === "Slash";
    case ".":
      return k === "." || code === "Period";
    case ",":
      return k === "," || code === "Comma";
    default:
      if (/^[0-9]$/.test(key)) return code === `Digit${key}` || k === key;
      if (/^[a-z]$/i.test(key)) return code === `Key${key.toUpperCase()}` || k.toLowerCase() === key.toLowerCase();
      return k === key;
  }
}

/** Pretty label for menus / cheat sheet. */
export function chordLabel(chord: string): string {
  const map: Record<string, string> = isMac
    ? { Mod: "⌘", Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Enter: "⏎", Escape: "⎋", Tab: "⇥", Backspace: "⌫", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→" }
    : { Mod: "Ctrl", Ctrl: "Ctrl", Alt: "Alt", Shift: "Shift", Enter: "Enter", Escape: "Esc", Tab: "Tab", Backspace: "⌫", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→" };
  const parts = chord.split("+").map((p) => map[p] ?? p.toUpperCase());
  return isMac ? parts.join("") : parts.join("+");
}

export function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}
