/** Client-side SQL helpers: statement splitting (for cursor location only), auto-titles, a small beautifier. */

export interface StatementRange {
  text: string;
  from: number;
  to: number;
}

/** Split on `;` outside strings/comments. The backend does the authoritative split. */
export function splitStatements(sql: string): StatementRange[] {
  const out: StatementRange[] = [];
  let start = 0;
  let quote: string | null = null;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl < 0 ? sql.length : nl;
      continue;
    } else if (ch === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? sql.length : end + 2;
      continue;
    } else if (ch === ";") {
      push(start, i + 1);
      start = i + 1;
    }
    i++;
  }
  push(start, sql.length);
  return out;

  function push(from: number, to: number) {
    const raw = sql.slice(from, to);
    const lead = raw.length - raw.trimStart().length;
    const trail = raw.length - raw.trimEnd().length;
    const text = raw.trim().replace(/;$/, "").trim();
    if (text) out.push({ text, from: from + lead, to: to - trail });
  }
}

export function statementAt(sql: string, pos: number): StatementRange | null {
  const parts = splitStatements(sql);
  if (!parts.length) return null;
  for (const p of parts) if (pos >= p.from && pos <= p.to) return p;
  // between statements: pick the nearest preceding one, else the first
  let best = parts[0];
  for (const p of parts) if (p.to <= pos) best = p;
  return best;
}

/** `select … from orders` — compact title from the first statement. */
export function autoTitle(sql: string): string {
  const first = splitStatements(sql)[0]?.text ?? "";
  if (!first) return "";
  const norm = first.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim();
  const m = /^(select|with)\b.*?\bfrom\s+([\w."]+)/i.exec(norm);
  if (m) return `select … from ${m[2].replace(/"/g, "")}`;
  const m2 = /^(insert\s+into|update|delete\s+from|create\s+\w+|alter\s+\w+|drop\s+\w+|truncate)\s+([\w."]+)/i.exec(norm);
  if (m2) return `${m2[1].toLowerCase()} ${m2[2].replace(/"/g, "")}`;
  return norm.length > 28 ? norm.slice(0, 26) + "…" : norm;
}

const CLAUSES = ["select", "from", "where", "group by", "having", "order by", "limit", "offset", "union all", "union", "left join", "right join", "inner join", "full join", "cross join", "join", "on", "values", "set", "returning", "with", "insert into", "update", "delete from"];
const KEYWORDS = new Set(["select", "from", "where", "and", "or", "not", "in", "is", "null", "as", "group", "by", "order", "having", "limit", "offset", "join", "left", "right", "inner", "outer", "full", "cross", "on", "insert", "into", "values", "update", "set", "delete", "create", "table", "view", "alter", "drop", "distinct", "case", "when", "then", "else", "end", "union", "all", "exists", "between", "like", "ilike", "asc", "desc", "returning", "with", "true", "false", "count", "sum", "avg", "min", "max", "coalesce", "cast", "primary", "key", "references", "default", "index", "unique"]);

/** Keyword-uppercasing, newline-before-clauses formatter. Deliberately simple. */
export function beautify(sql: string): string {
  const parts = splitStatements(sql);
  const formatted = parts.map((p) => formatOne(p.text));
  return formatted.join(";\n\n") + (parts.length ? ";" : "");
}

function formatOne(text: string): string {
  // tokenise keeping strings and comments intact
  const tokens: string[] = [];
  const re = /('(?:[^']|'')*'|"[^"]*"|--[^\n]*|\/\*[\s\S]*?\*\/|\s+|[A-Za-z_][\w.]*|\d+(?:\.\d+)?|[(),;=<>!*+\-/]|.)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) tokens.push(m[0]);
  let out = "";
  let depth = 0;
  const words = tokens.filter((t) => !/^\s+$/.test(t));
  for (let i = 0; i < words.length; i++) {
    let w = words[i];
    const lower = w.toLowerCase();
    if (/^[A-Za-z_][\w.]*$/.test(w) && KEYWORDS.has(lower)) w = w.toUpperCase();
    // clause detection (two-word clauses)
    const two = i + 1 < words.length ? `${lower} ${words[i + 1].toLowerCase()}` : "";
    const clause = CLAUSES.find((c) => c === two) ?? CLAUSES.find((c) => c === lower);
    const isClause = !!clause && depth === 0 && /^[A-Za-z]/.test(w);
    if (isClause && out.trim()) out = out.trimEnd() + "\n";
    if (clause && clause.includes(" ") && clause === two) {
      out += clause.toUpperCase() + " ";
      i++;
      continue;
    }
    if (w === "(") depth++;
    if (w === ")") depth--;
    if (w === "," ) {
      out = out.trimEnd() + ", ";
      continue;
    }
    if (w === "(" || w === ")") {
      out = (w === ")" ? out.trimEnd() : out) + w + (w === ")" ? " " : "");
      continue;
    }
    if (/^(and|or)$/i.test(w) && depth === 0) {
      out = out.trimEnd() + "\n  " + w.toUpperCase() + " ";
      continue;
    }
    if (w.startsWith("--")) {
      out += w + "\n";
      continue;
    }
    if (/^[=<>!*+\-/]$/.test(w) || /^[=<>!]+$/.test(w)) {
      out = out.trimEnd() + " " + w + " ";
      continue;
    }
    out += w + " ";
  }
  return out
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .replace(/\( /g, "(")
    .replace(/ \)/g, ")")
    .trim();
}

export function lineColToOffset(text: string, line: number, column: number): number {
  const lines = text.split("\n");
  let off = 0;
  for (let i = 0; i < line - 1 && i < lines.length; i++) off += lines[i].length + 1;
  return Math.min(text.length, off + Math.max(0, column - 1));
}

/** Length of the identifier-ish token at `offset`. */
export function tokenLengthAt(text: string, offset: number): number {
  const m = /^("[^"]*"|'[^']*'|[\w.]+|\S)/.exec(text.slice(offset));
  return m ? m[0].length : 1;
}
