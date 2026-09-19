import { flatten, type JsonDoc } from "./model";

/**
 * A JSON parser that does not give up.
 *
 * `JSON.parse` is all or nothing: one stray comma in a 40 MB payload and you
 * get a message with a character offset and no document. That is the opposite
 * of what a person needs, because the reason they opened the viewer is that
 * something is wrong with the file and they want to see *where*.
 *
 * So this one parses what it can, records every problem with its offset and
 * its path, and keeps going. Two kinds of problem:
 *
 *   • **error** — the text is wrong and something was skipped or guessed.
 *   • **lenient** — the text is not JSON but its meaning is unambiguous: a
 *     trailing comma, a comment, a single-quoted string, an unquoted key,
 *     `NaN`. Every one of these is something a real file has in it, and
 *     refusing to open the file over one is not helping anybody.
 *
 * It is iterative, not recursive: a deeply nested document must not be able
 * to end the tab with a stack overflow.
 */

export type IssueKind = "error" | "lenient";

export interface JsonIssue {
  kind: IssueKind;
  message: string;
  /** Character offset into the source text. */
  offset: number;
  /** `$.rows[3].name` — where in the document, as far as it got. */
  path: string;
  /** Index of the node it belongs to, once the tree is built. */
  node: number;
}

export interface TolerantResult {
  doc: JsonDoc;
  issues: JsonIssue[];
  /** True when the input ran out mid-document — a truncated file. */
  truncated: boolean;
}

const WS = new Set([" ", "\t", "\n", "\r", "﻿"]);

/** Marks a value we could not read, so the tree can show the hole. */
export const UNREADABLE = Symbol("unreadable");

export function parseTolerant(text: string): TolerantResult {
  const issues: JsonIssue[] = [];
  let i = 0;
  let truncated = false;
  /** Path components as we descend, for the issue messages. */
  const path: (string | number)[] = [];

  const pathString = (): string =>
    "$" +
    path
      .map((p) => (typeof p === "number" ? `[${p}]` : /^[A-Za-z_]\w*$/.test(p) ? `.${p}` : `[${JSON.stringify(p)}]`))
      .join("");

  const note = (kind: IssueKind, message: string, at = i) => {
    // One complaint per position: a run of bad bytes is one problem, not ten.
    if (issues.length && issues[issues.length - 1].offset === at) return;
    issues.push({ kind, message, offset: at, path: pathString(), node: -1 });
  };

  const skipWs = () => {
    for (;;) {
      while (i < text.length && WS.has(text[i])) i++;
      // Comments are not JSON, and are in half the config files ever written.
      if (text[i] === "/" && text[i + 1] === "/") {
        note("lenient", "Line comment — not valid JSON", i);
        while (i < text.length && text[i] !== "\n") i++;
        continue;
      }
      if (text[i] === "/" && text[i + 1] === "*") {
        note("lenient", "Block comment — not valid JSON", i);
        const end = text.indexOf("*/", i + 2);
        i = end < 0 ? text.length : end + 2;
        continue;
      }
      return;
    }
  };

  const readString = (): string => {
    const quote = text[i];
    if (quote === "'") note("lenient", "Single-quoted string — JSON uses double quotes", i);
    i++;
    let out = "";
    for (;;) {
      if (i >= text.length) {
        truncated = true;
        note("error", "String is not closed before the end of the document", i);
        return out;
      }
      const c = text[i];
      if (c === quote) {
        i++;
        return out;
      }
      if (c === "\\") {
        const esc = text[i + 1];
        i += 2;
        switch (esc) {
          case "n": out += "\n"; break;
          case "t": out += "\t"; break;
          case "r": out += "\r"; break;
          case "b": out += "\b"; break;
          case "f": out += "\f"; break;
          case "u": {
            const hex = text.slice(i, i + 4);
            if (/^[0-9a-fA-F]{4}$/.test(hex)) {
              out += String.fromCharCode(parseInt(hex, 16));
              i += 4;
            } else {
              note("error", "Bad \\u escape", i - 2);
              out += "\\u";
            }
            break;
          }
          case undefined:
            truncated = true;
            note("error", "Document ends inside an escape", i);
            return out;
          default:
            out += esc;
        }
        continue;
      }
      out += c;
      i++;
    }
  };

  /**
   * Recovery: skip to the next `,` or to the closing bracket at this depth,
   * so one bad member costs one member rather than the rest of the file.
   * Structural characters are never consumed here — the loop needs them.
   */
  const recover = () => {
    let depth = 0;
    while (i < text.length) {
      const c = text[i];
      if (c === '"' || c === "'") {
        readString();
        continue;
      }
      if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") {
        if (depth === 0) return;
        depth--;
      } else if (c === "," && depth === 0) return;
      i++;
    }
  };

  /** A bare word: `true`, `NaN`, or an unquoted key someone hand-wrote. */
  const readBareword = (): string => {
    const start = i;
    while (i < text.length && /[\w+.\-$]/.test(text[i])) i++;
    return text.slice(start, i);
  };

  const readNumberOrWord = (): unknown => {
    const start = i;
    const word = readBareword();
    if (!word) {
      note("error", `Unexpected ${JSON.stringify(text[i] ?? "end of document")}`, start);
      // Skip the whole run of nonsense here rather than one character, or the
      // caller reports the same mistake again as "expected ',' or '}'".
      recover();
      return UNREADABLE;
    }
    if (word === "true") return true;
    if (word === "false") return false;
    if (word === "null") return null;
    if (word === "NaN") {
      note("lenient", "NaN is not valid JSON", start);
      return NaN;
    }
    if (word === "Infinity" || word === "+Infinity") {
      note("lenient", "Infinity is not valid JSON", start);
      return Infinity;
    }
    if (word === "-Infinity") {
      note("lenient", "-Infinity is not valid JSON", start);
      return -Infinity;
    }
    const n = Number(word);
    if (!Number.isNaN(n)) {
      if (/^[+.]|^-?0\d|\.$/.test(word)) note("lenient", `${word} is not a valid JSON number`, start);
      return n;
    }
    note("error", `Unexpected ${JSON.stringify(word)}`, start);
    return UNREADABLE;
  };

  /**
   * Read one value.
   *
   * Returns `OPEN` for `{` or `[` — the caller pushes a frame, because this
   * parser does not recurse. A document nested fifty thousand deep is a
   * document, not a crash.
   */
  const OPEN = Symbol("open");
  const readPrimitive = (): unknown | typeof OPEN => {
    skipWs();
    if (i >= text.length) {
      truncated = true;
      note("error", "Document ends where a value was expected", i);
      return UNREADABLE;
    }
    const c = text[i];
    if (c === "{" || c === "[") return OPEN;
    if (c === '"' || c === "'") return readString();
    // A structural character where a value belongs: report it and leave it
    // where it is, so the container that owns it can close properly.
    if (c === "}" || c === "]" || c === "," || c === ":") {
      note("error", `Expected a value, found ${JSON.stringify(c)}`, i);
      return UNREADABLE;
    }
    return readNumberOrWord();
  };

  interface Frame {
    kind: "object" | "array";
    container: Record<string, unknown> | unknown[];
    /** The key read but not yet given a value. */
    key: string | null;
  }
  const stack: Frame[] = [];
  let root: unknown = UNREADABLE;
  let rootDone = false;

  /** Give a finished value to whatever is waiting for it. */
  const attach = (value: unknown) => {
    const top = stack[stack.length - 1];
    const v = value === UNREADABLE ? null : value;
    if (!top) {
      root = v;
      rootDone = true;
      return;
    }
    if (top.kind === "array") (top.container as unknown[]).push(v);
    else (top.container as Record<string, unknown>)[top.key ?? ""] = v;
  };

  /** Start a container, attach it to its parent, and descend. */
  const open = () => {
    const kind = text[i] === "{" ? "object" : "array";
    const container: Record<string, unknown> | unknown[] = kind === "object" ? {} : [];
    attach(container);
    if (stack.length) path.push(stack[stack.length - 1].kind === "array" ? (stack[stack.length - 1].container as unknown[]).length - 1 : (stack[stack.length - 1].key ?? ""));
    i++;
    stack.push({ kind, container, key: null });
  };

  const close = () => {
    stack.pop();
    if (stack.length) path.pop();
    else if (path.length) path.pop();
    if (!stack.length) rootDone = true;
  };

  /** After a member: a comma carries on, a bracket closes, anything else is
   *  an error we recover from. */
  const afterMember = (closing: string): "continue" | "closed" => {
    skipWs();
    if (text[i] === ",") {
      i++;
      skipWs();
      if (text[i] === closing) note("lenient", "Trailing comma", i - 1);
      return "continue";
    }
    if (text[i] === closing) {
      i++;
      close();
      return "closed";
    }
    if (i >= text.length) {
      truncated = true;
      note("error", `${closing === "}" ? "Object" : "Array"} is not closed before the end of the document`, i);
      close();
      return "closed";
    }
    note("error", `Expected ',' or '${closing}'`);
    recover();
    if (text[i] === ",") i++;
    return "continue";
  };

  // ── the machine
  for (;;) {
    const top = stack[stack.length - 1];

    if (!top) {
      if (rootDone) break;
      const v = readPrimitive();
      if (v === OPEN) open();
      else attach(v);
      continue;
    }

    skipWs();
    if (i >= text.length) {
      truncated = true;
      note("error", `${top.kind === "object" ? "Object" : "Array"} is not closed before the end of the document`, i);
      close();
      continue;
    }

    const closing = top.kind === "object" ? "}" : "]";
    if (text[i] === closing) {
      i++;
      close();
      // The container that just finished is a member of its parent, so the
      // parent consumes what follows it. Without this the parent's loop sees
      // the separating comma and calls it an empty member.
      for (let parent = stack[stack.length - 1]; parent; parent = stack[stack.length - 1]) {
        if (afterMember(parent.kind === "object" ? "}" : "]") !== "closed") break;
      }
      continue;
    }
    if (text[i] === ",") {
      note("error", top.kind === "object" ? "Empty member" : "Empty element", i);
      i++;
      continue;
    }

    if (top.kind === "object") {
      // ── the key
      let key: string;
      if (text[i] === '"' || text[i] === "'") key = readString();
      else {
        const at = i;
        key = readBareword();
        if (!key) {
          note("error", `Unexpected ${JSON.stringify(text[i])} where a key was expected`, i);
          recover();
          if (text[i] === ",") i++;
          continue;
        }
        note("lenient", "Unquoted key — JSON requires quotes", at);
      }
      top.key = key;
      skipWs();
      if (text[i] === ":") i++;
      else note("error", "Missing ':' after the key", i);
      path.push(key);
      const v = readPrimitive();
      path.pop();
      if (v === OPEN) {
        path.push(key);
        const kind = text[i] === "{" ? "object" : "array";
        const container: Record<string, unknown> | unknown[] = kind === "object" ? {} : [];
        (top.container as Record<string, unknown>)[key] = container;
        i++;
        stack.push({ kind, container, key: null });
        continue;
      }
      (top.container as Record<string, unknown>)[key] = v === UNREADABLE ? null : v;
      afterMember("}");
      continue;
    }

    // ── an array element
    const arr = top.container as unknown[];
    path.push(arr.length);
    const v = readPrimitive();
    path.pop();
    if (v === OPEN) {
      path.push(arr.length);
      const kind = text[i] === "{" ? "object" : "array";
      const container: Record<string, unknown> | unknown[] = kind === "object" ? {} : [];
      arr.push(container);
      i++;
      stack.push({ kind, container, key: null });
      continue;
    }
    arr.push(v === UNREADABLE ? null : v);
    afterMember("]");
  }

  const value = root;
  skipWs();
  if (i < text.length) {
    // NDJSON and concatenated payloads land here; say which it is.
    note("error", `Extra content after the document (${text.length - i} more characters)`, i);
  }

  const doc = flatten(value === UNREADABLE ? null : value, new Blob([text]).size);
  attachIssues(doc, issues);
  return { doc, issues, truncated };
}

/**
 * Point each issue at the node its path names, so the tree can mark the row
 * and jump to it. Paths are compared by walking, which is cheap because there
 * are far fewer issues than nodes.
 */
function attachIssues(doc: JsonDoc, issues: JsonIssue[]): void {
  if (!issues.length) return;
  const byPath = new Map<string, number>();
  const build = (i: number, prefix: string) => {
    const node = doc.nodes[i];
    const own = node.key == null ? "$" : node.indexed ? `${prefix}[${node.key}]` : /^[A-Za-z_]\w*$/.test(node.key) ? `${prefix}.${node.key}` : `${prefix}[${JSON.stringify(node.key)}]`;
    byPath.set(own, i);
    let c = i + 1;
    while (c < node.end) {
      build(c, own);
      c = doc.nodes[c].end;
    }
  };
  // Iterative walk, same reason as everywhere else in this file.
  const stack: { i: number; prefix: string }[] = [{ i: 0, prefix: "" }];
  while (stack.length) {
    const { i, prefix } = stack.pop()!;
    const node = doc.nodes[i];
    const own = node.key == null ? "$" : node.indexed ? `${prefix}[${node.key}]` : /^[A-Za-z_]\w*$/.test(node.key) ? `${prefix}.${node.key}` : `${prefix}[${JSON.stringify(node.key)}]`;
    byPath.set(own, i);
    let c = i + 1;
    while (c < node.end) {
      stack.push({ i: c, prefix: own });
      c = doc.nodes[c].end;
    }
  }
  void build;
  for (const issue of issues) issue.node = byPath.get(issue.path) ?? 0;
}

/** Line and column for an offset, for the message. */
export function lineColOf(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let last = -1;
  for (let n = 0; n < offset && n < text.length; n++) {
    if (text[n] === "\n") {
      line++;
      last = n;
    }
  }
  return { line, column: offset - last };
}
