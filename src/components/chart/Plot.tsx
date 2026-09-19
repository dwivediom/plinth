import { useMemo, useState } from "react";
import type { ChartForm } from "../../state/types";
import { arcPath, areaPath, barPath, linePath, linearScale, niceMax, seriesColor, shortNumber, ticks } from "./marks";

export interface Series {
  name: string;
  values: (number | null)[];
}

export interface PlotData {
  /** Category labels, or x values already formatted. */
  labels: string[];
  series: Series[];
  /** Numeric x for scatter; when absent, categories are used. */
  xValues?: number[];
  xLabel?: string;
  yLabel?: string;
}

const PAD = { top: 16, right: 20, bottom: 34, left: 52 };
/** The 2px gap the spec asks for between adjacent fills. */
const GAP = 2;

interface Hover {
  x: number;
  y: number;
  lines: string[];
}

/**
 * One SVG, five forms. Every form ships a hover layer — a chart in a window is
 * interactive by default — and a legend whenever more than one series is drawn,
 * so identity is never carried by colour alone.
 */
export function Plot({ data, form, width, height, svgRef }: { data: PlotData; form: ChartForm; width: number; height: number; svgRef?: React.Ref<SVGSVGElement> }) {
  const [hover, setHover] = useState<Hover | null>(null);
  const plotW = Math.max(40, width - PAD.left - PAD.right);
  const plotH = Math.max(40, height - PAD.top - PAD.bottom);

  const max = useMemo(() => {
    const all = data.series.flatMap((s) => s.values.filter((v): v is number => v != null));
    return niceMax(Math.max(1, ...all));
  }, [data]);

  const y = linearScale([0, max], [PAD.top + plotH, PAD.top]);
  const n = data.labels.length;
  const band = n ? plotW / n : plotW;

  const grid = ticks(max).map((t) => (
    <g key={t}>
      <line x1={PAD.left} x2={PAD.left + plotW} y1={y(t)} y2={y(t)} className="grid" />
      <text x={PAD.left - 8} y={y(t)} className="tick" textAnchor="end" dominantBaseline="middle">
        {shortNumber(t)}
      </text>
    </g>
  ));

  // Labels are thinned rather than rotated: a readable subset beats a wall of
  // 45° text nobody can scan.
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 64))));
  const xTicks = data.labels.map((label, i) =>
    i % every === 0 ? (
      <text key={i} x={PAD.left + band * (i + 0.5)} y={PAD.top + plotH + 16} className="tick" textAnchor="middle">
        {label.length > 12 ? `${label.slice(0, 11)}…` : label}
      </text>
    ) : null,
  );

  const show = (e: React.MouseEvent<SVGElement>, lines: string[]) => {
    const box = (e.currentTarget.ownerSVGElement ?? e.currentTarget).getBoundingClientRect();
    setHover({ x: e.clientX - box.left, y: e.clientY - box.top, lines });
  };

  let marks: React.ReactNode = null;

  if (form === "bar") {
    const groups = data.series.length;
    const groupW = Math.max(2, band - GAP * 2);
    const barW = Math.max(1, groupW / groups - (groups > 1 ? GAP : 0));
    // Selective direct labels — never a number on every point, but few enough
    // bars and the value belongs on the mark. In light mode this is also the
    // relief the palette's low-contrast slots require.
    const label = n <= 12 && groups === 1;
    marks = data.labels.map((label_, i) =>
      data.series.map((s, si) => {
        const v = s.values[i];
        if (v == null) return null;
        const h = Math.max(1, PAD.top + plotH - y(v));
        const x = PAD.left + band * i + GAP + si * (barW + GAP);
        return (
          <g key={`${i}-${si}`}>
            <path
              d={barPath(x, y(v), barW, h)}
              fill={seriesColor(si)}
              onMouseMove={(e) => show(e, [label_, `${s.name}: ${shortNumber(v)}`])}
              onMouseLeave={() => setHover(null)}
            />
            {label && (
              <text x={x + barW / 2} y={y(v) - 6} className="value" textAnchor="middle">
                {shortNumber(v)}
              </text>
            )}
          </g>
        );
      }),
    );
  }

  if (form === "line" || form === "area") {
    marks = data.series.map((s, si) => {
      const pts = s.values
        .map((v, i): [number, number] | null => (v == null ? null : [PAD.left + band * (i + 0.5), y(v)]))
        .filter((p): p is [number, number] => p != null);
      return (
        <g key={s.name}>
          {form === "area" && <path d={areaPath(pts, PAD.top + plotH)} fill={seriesColor(si)} opacity={0.18} />}
          <path d={linePath(pts)} fill="none" stroke={seriesColor(si)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {pts.length <= 40 &&
            pts.map(([px, py], i) => (
              <circle
                key={i}
                cx={px}
                cy={py}
                r={4}
                fill={seriesColor(si)}
                stroke="var(--chart-surface)"
                strokeWidth={2}
                onMouseMove={(e) => show(e, [data.labels[i] ?? "", `${s.name}: ${shortNumber(s.values[i] ?? 0)}`])}
                onMouseLeave={() => setHover(null)}
              />
            ))}
        </g>
      );
    });
  }

  if (form === "scatter") {
    const xs = data.xValues ?? data.labels.map((_, i) => i);
    const xMax = niceMax(Math.max(1, ...xs));
    const sx = linearScale([Math.min(0, ...xs), xMax], [PAD.left, PAD.left + plotW]);
    marks = data.series.map((s, si) =>
      s.values.map((v, i) =>
        v == null ? null : (
          <circle
            key={`${si}-${i}`}
            cx={sx(xs[i] ?? 0)}
            cy={y(v)}
            r={5}
            fill={seriesColor(si)}
            stroke="var(--chart-surface)"
            strokeWidth={2}
            onMouseMove={(e) => show(e, [`${data.xLabel ?? "x"}: ${shortNumber(xs[i] ?? 0)}`, `${s.name}: ${shortNumber(v)}`])}
            onMouseLeave={() => setHover(null)}
          />
        ),
      ),
    );
  }

  if (form === "donut") {
    const values = data.labels.map((_, i) => data.series[0]?.values[i] ?? 0).map((v) => (v == null ? 0 : v));
    const total = values.reduce((a, b) => a + b, 0) || 1;
    const cx = width / 2;
    const cy = PAD.top + plotH / 2;
    const r = Math.max(20, Math.min(plotW, plotH) / 2 - 10);
    let angle = -Math.PI / 2;
    marks = values.map((v, i) => {
      const sweep = (v / total) * Math.PI * 2;
      // A hair off each end is the 2px surface gap, in angular form.
      const pad = Math.min(0.02, sweep / 8);
      const d = arcPath(cx, cy, r, r * 0.58, angle + pad, angle + sweep - pad);
      angle += sweep;
      return (
        <path
          key={i}
          d={d}
          fill={seriesColor(i)}
          onMouseMove={(e) => show(e, [data.labels[i] ?? "", `${shortNumber(v)} · ${((v / total) * 100).toFixed(1)}%`])}
          onMouseLeave={() => setHover(null)}
        />
      );
    });
  }

  const axes = form !== "donut";

  return (
    <div className="plotwrap">
      <svg ref={svgRef} className="plot" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${form} chart`}>
        {axes && grid}
        {axes && xTicks}
        {axes && <line x1={PAD.left} x2={PAD.left + plotW} y1={PAD.top + plotH} y2={PAD.top + plotH} className="axis" />}
        {marks}
      </svg>
      {hover && (
        <div className="plot-tip" style={{ left: hover.x + 12, top: hover.y + 12 }}>
          {hover.lines.map((l, i) => (
            <div key={i} className={i === 0 ? "k" : "v"}>
              {l}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Identity never rests on colour alone: every multi-series chart gets this. */
export function Legend({ names }: { names: string[] }) {
  if (names.length < 2) return null;
  return (
    <div className="plot-legend">
      {names.map((n, i) => (
        <span key={n}>
          <i style={{ background: seriesColor(i) }} /> {n}
        </span>
      ))}
    </div>
  );
}
