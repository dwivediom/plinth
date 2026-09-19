/**
 * Chart marks, built by hand in SVG.
 *
 * SVG rather than canvas so that "download a transparent PNG" is a
 * serialisation of what is on screen, not a screenshot of it. Mark geometry
 * follows the data-viz spec: 4px rounded data-ends anchored to the baseline,
 * 2px lines, 8px markers, a 2px surface gap between adjacent fills.
 *
 * Colour comes from `--series-1…8` — a fixed order, never cycled, validated
 * against this app's own surfaces in both modes.
 */

export const SERIES_SLOTS = 8;
export const seriesColor = (i: number) => `var(--series-${(i % SERIES_SLOTS) + 1})`;

export interface Scale {
  (v: number): number;
}

export function linearScale(domain: [number, number], range: [number, number]): Scale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  return (v: number) => r0 + ((v - d0) / span) * (r1 - r0);
}

/** A "nice" axis maximum, so the top gridline is a round number. */
export function niceMax(max: number): number {
  if (max <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(max));
  const n = max / mag;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * mag;
}

export function ticks(max: number, count = 4): number[] {
  const step = max / count;
  return Array.from({ length: count + 1 }, (_, i) => i * step);
}

/** Short axis labels: 12.4k, 3.1M — never a wall of digits. */
export function shortNumber(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1e12) return `${(v / 1e12).toFixed(abs >= 1e13 ? 0 : 1)}T`;
  if (abs >= 1e9) return `${(v / 1e9).toFixed(abs >= 1e10 ? 0 : 1)}B`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (abs >= 1e3) return `${(v / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}k`;
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(2);
}

/** A bar with its top corners rounded and its base square on the axis. */
export function barPath(x: number, y: number, w: number, h: number, r = 4): string {
  const radius = Math.max(0, Math.min(r, w / 2, h));
  return `M${x},${y + h} L${x},${y + radius} Q${x},${y} ${x + radius},${y} L${x + w - radius},${y} Q${x + w},${y} ${x + w},${y + radius} L${x + w},${y + h} Z`;
}

export function linePath(points: [number, number][]): string {
  return points.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
}

export function areaPath(points: [number, number][], baseline: number): string {
  if (!points.length) return "";
  const first = points[0];
  const last = points[points.length - 1];
  return `${linePath(points)} L${last[0].toFixed(2)},${baseline} L${first[0].toFixed(2)},${baseline} Z`;
}

/** Donut segment. Two arcs and two radii — no library needed for one shape. */
export function arcPath(cx: number, cy: number, rOuter: number, rInner: number, from: number, to: number): string {
  const large = to - from > Math.PI ? 1 : 0;
  const p = (r: number, a: number): [number, number] => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  const [x0, y0] = p(rOuter, from);
  const [x1, y1] = p(rOuter, to);
  const [x2, y2] = p(rInner, to);
  const [x3, y3] = p(rInner, from);
  return `M${x0},${y0} A${rOuter},${rOuter} 0 ${large} 1 ${x1},${y1} L${x2},${y2} A${rInner},${rInner} 0 ${large} 0 ${x3},${y3} Z`;
}
