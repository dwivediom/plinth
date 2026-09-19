/** Subsequence matcher with Spotlight-style ranking. */

export interface FuzzyMatch {
  /** 0 exact · 1 prefix · 2 word boundary · 3 subsequence */
  tier: number;
  score: number;
  indices: number[];
}

export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return { tier: 4, score: 0, indices: [] };
  if (t === q) return { tier: 0, score: 1000, indices: range(0, q.length) };
  if (t.startsWith(q)) return { tier: 1, score: 900 - t.length, indices: range(0, q.length) };
  const wb = wordBoundaryIndex(t, q);
  if (wb >= 0) return { tier: 2, score: 800 - wb - t.length, indices: range(wb, wb + q.length) };
  // subsequence
  const indices: number[] = [];
  let ti = 0;
  let gaps = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const idx = t.indexOf(q[qi], ti);
    if (idx < 0) return null;
    if (indices.length && idx !== indices[indices.length - 1] + 1) gaps++;
    indices.push(idx);
    ti = idx + 1;
  }
  return { tier: 3, score: 500 - gaps * 20 - indices[0] - t.length, indices };
}

function wordBoundaryIndex(t: string, q: string): number {
  let from = 0;
  while (from <= t.length - q.length) {
    const idx = t.indexOf(q, from);
    if (idx < 0) return -1;
    if (idx === 0 || /[^a-z0-9]/.test(t[idx - 1])) return idx;
    from = idx + 1;
  }
  return -1;
}

function range(a: number, b: number) {
  const out: number[] = [];
  for (let i = a; i < b; i++) out.push(i);
  return out;
}

/** Splits `text` into [chunk, matched] pairs for rendering bold matches. */
export function highlightChunks(text: string, indices: number[]): { text: string; hit: boolean }[] {
  if (!indices.length) return [{ text, hit: false }];
  const set = new Set(indices);
  const out: { text: string; hit: boolean }[] = [];
  let cur = "";
  let curHit = set.has(0);
  for (let i = 0; i < text.length; i++) {
    const hit = set.has(i);
    if (hit !== curHit) {
      if (cur) out.push({ text: cur, hit: curHit });
      cur = "";
      curHit = hit;
    }
    cur += text[i];
  }
  if (cur) out.push({ text: cur, hit: curHit });
  return out;
}

export function compareMatches(a: FuzzyMatch, b: FuzzyMatch) {
  return a.tier - b.tier || b.score - a.score;
}
