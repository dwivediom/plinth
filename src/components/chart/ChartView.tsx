import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, RotateCw, Table2 } from "lucide-react";
import { Segmented } from "../../components/common/Overlays";
import { errorMessage, invoke } from "../../ipc/client";
import type { Cell, ColumnDesc } from "../../ipc/types";
import { COMBINED, chooseColumns, isNumericColumn as numeric } from "../../lib/chartColumns";
import { cellText } from "../../lib/format";
import { toast } from "../../state/overlays";
import type { ChartForm, ChartTab } from "../../state/types";
import { useWorkspaces } from "../../state/workspaces";
import { Legend, Plot, type PlotData } from "./Plot";
import { seriesColor } from "./marks";

/** Enough rows for a shape; past this a chart is a smear, not a picture. */
const MAX_ROWS = 500;
const MAX_SERIES = 8;

interface Loaded {
  columns: ColumnDesc[];
  rows: Cell[][];
}

/** Top N by value, everything else folded into one slice — a ninth colour is
 *  never invented. */
function foldOther(labels: string[], values: number[], keep: number): { labels: string[]; values: number[] } {
  if (labels.length <= keep) return { labels, values };
  const order = labels.map((l, i) => ({ l, v: values[i] ?? 0 })).sort((a, b) => b.v - a.v);
  const head = order.slice(0, keep - 1);
  const rest = order.slice(keep - 1).reduce((a, b) => a + b.v, 0);
  return { labels: [...head.map((h) => h.l), "Other"], values: [...head.map((h) => h.v), rest] };
}

/** Decimals arrive as strings on purpose (exactness), so parse rather than cast. */
function toNumber(v: Cell): number | null {
  if (v == null || typeof v === "boolean" || typeof v === "object") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function ChartView({ workspaceId, tabId }: { workspaceId: string; tabId: string }) {
  const tab = useWorkspaces((s) => s.byId[workspaceId]?.tabs.find((t) => t.id === tabId)) as ChartTab | undefined;
  const updateTab = useWorkspaces((s) => s.updateTab);
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [size, setSize] = useState({ width: 720, height: 420 });
  const host = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);

  const sql = tab?.sql ?? "";
  const form = tab?.form ?? "bar";

  const load = useCallback(async () => {
    if (!sql.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const results = await invoke("query_run", { workspaceId, sql, limit: MAX_ROWS, source: "ai" });
      const first = results[0];
      if (!first) throw new Error("The query returned nothing to chart.");
      if (first.error) throw new Error(first.error.message);
      let rows: Cell[][] = [];
      if (first.cursorId) {
        const window = await invoke("cursor_fetch", { cursorId: first.cursorId, offset: 0, len: MAX_ROWS });
        rows = window.rows;
        void invoke("cursor_close", { cursorId: first.cursorId }).catch(() => {});
      }
      setData({ columns: first.columns, rows });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [sql, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  // The plot is drawn at the size it is given, so it must follow the pane.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ width: Math.max(320, width - 32), height: Math.max(220, height - 32) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const columns = data?.columns ?? [];
  const { numericColumns, dimensions, labelColumn, valueColumns, combinedOf } = useMemo(
    () => chooseColumns(columns, data?.rows ?? [], sql, tab?.x, tab?.y, MAX_SERIES),
    [columns, data, sql, tab?.x, tab?.y],
  );

  const plot: PlotData | null = useMemo(() => {
    if (!data || !data.rows.length || !labelColumn) return null;
    const index = (name: string) => columns.findIndex((c) => c.name === name);
    const parts = (labelColumn === COMBINED ? combinedOf : [labelColumn]).map(index).filter((i) => i >= 0);
    if (!parts.length) return null;
    const rawLabels = data.rows.map((r) => parts.map((i) => cellText(r[i], columns[i]?.logical ?? "text")).join(" · "));
    const onX = new Set(parts.map((i) => columns[i].name));
    let series = valueColumns
      .filter((name) => index(name) >= 0 && !onX.has(name))
      .map((name) => ({ name, values: data.rows.map((r) => toNumber(r[index(name)])) }));
    if (!series.length) return null;
    let labels = rawLabels;

    // A category that repeats is a group, not a row: summing is what a person
    // means by "orders by status". Line, area and scatter keep row order.
    const repeats = new Set(rawLabels).size < rawLabels.length;
    if (repeats && (form === "bar" || form === "donut")) {
      const totals = new Map<string, number[]>();
      rawLabels.forEach((label, i) => {
        const acc = totals.get(label) ?? series.map(() => 0);
        series.forEach((s, si) => (acc[si] += s.values[i] ?? 0));
        totals.set(label, acc);
      });
      labels = [...totals.keys()];
      series = series.map((s, si) => ({ ...s, values: labels.map((l) => totals.get(l)?.[si] ?? 0) }));
    }

    if (form === "donut" && series[0]) {
      const folded = foldOther(labels, series[0].values.map((v) => v ?? 0), MAX_SERIES);
      labels = folded.labels;
      series = [{ ...series[0], values: folded.values }];
    }

    const li = parts.length === 1 ? parts[0] : -1;
    const xNumeric = li >= 0 && numeric(columns[li]) && !repeats ? data.rows.map((r) => toNumber(r[li]) ?? 0) : undefined;
    return { labels, series, xValues: xNumeric, xLabel: li >= 0 ? columns[li].name : combinedOf.join(" · ") };
  }, [data, columns, labelColumn, combinedOf, valueColumns, form]);

  /**
   * Transparent PNG. The chart is SVG, so this is a serialisation at 2× — no
   * background is painted, which is the whole point: it drops onto a slide or
   * a dark README without a white box around it.
   */
  const download = async () => {
    const node = svg.current;
    if (!node) return;
    try {
      const clone = node.cloneNode(true) as SVGSVGElement;
      // Computed styles must be inlined: the clone leaves the document, and
      // with it every CSS variable the marks were painted with.
      const source = node.querySelectorAll("*");
      clone.querySelectorAll("*").forEach((el, i) => {
        const from = source[i];
        if (!from) return;
        const cs = getComputedStyle(from);
        for (const prop of ["fill", "stroke", "stroke-width", "opacity", "font-size", "font-family"]) {
          const value = cs.getPropertyValue(prop);
          if (value) (el as SVGElement).style.setProperty(prop, value);
        }
      });
      clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      const text = new XMLSerializer().serializeToString(clone);
      const image = new Image();
      const url = URL.createObjectURL(new Blob([text], { type: "image/svg+xml;charset=utf-8" }));
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = reject;
        image.src = url;
      });
      const canvas = document.createElement("canvas");
      canvas.width = size.width * 2;
      canvas.height = size.height * 2;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("No 2D context");
      // No fillRect: the alpha channel stays empty where nothing was drawn.
      ctx.scale(2, 2);
      ctx.drawImage(image, 0, 0, size.width, size.height);
      URL.revokeObjectURL(url);
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
      if (!blob) throw new Error("Could not encode the PNG");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${(tab?.title ?? "chart").replace(/\W+/g, "-").toLowerCase()}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      toast("Saved a transparent PNG at 2×");
    } catch (e) {
      toast(`Export failed: ${errorMessage(e)}`, "error");
    }
  };

  if (!tab) return null;

  return (
    <div className="chartview">
      <div className="chartbar">
        <Segmented
          small
          value={tab.form}
          onChange={(form: ChartForm) => updateTab<ChartTab>(workspaceId, tabId, { form })}
          ariaLabel="Chart type"
          options={[
            { value: "bar", label: "Bar" },
            { value: "line", label: "Line" },
            { value: "area", label: "Area" },
            { value: "scatter", label: "Scatter" },
            { value: "donut", label: "Donut" },
          ]}
        />
        <label htmlFor="chart-x">X</label>
        <select id="chart-x" className="native" value={labelColumn ?? ""} onChange={(e) => updateTab<ChartTab>(workspaceId, tabId, { x: e.target.value, y: null })}>
          {dimensions.length >= 2 && (
            <option value={COMBINED}>{dimensions.map((d) => d.name).join(" · ")}</option>
          )}
          {columns.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}
            </option>
          ))}
        </select>
        <label htmlFor="chart-y">Y</label>
        <select
          id="chart-y"
          className="native"
          multiple={false}
          value={valueColumns[0] ?? ""}
          onChange={(e) => updateTab<ChartTab>(workspaceId, tabId, { y: [e.target.value] })}
        >
          {numericColumns
            .filter((c) => (labelColumn === COMBINED ? !combinedOf.includes(c.name) : c.name !== labelColumn))
            .map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          {valueColumns.length > 1 && <option value="">(all numeric columns)</option>}
        </select>
        <span className="spacer" />
        <button className="icon-btn" title="Show the numbers" aria-pressed={tab.showTable} onClick={() => updateTab<ChartTab>(workspaceId, tabId, { showTable: !tab.showTable })}>
          <Table2 />
        </button>
        <button className="icon-btn" title="Re-run the query" onClick={() => void load()} disabled={loading}>
          <RotateCw />
        </button>
        <button className="btn" onClick={() => void download()} disabled={!plot}>
          <Download /> Transparent PNG
        </button>
      </div>

      {error && <div className="errrow">{error}</div>}

      <div className="chartbody" ref={host}>
        {loading && !data && <div className="empty" style={{ margin: "auto" }}>Running the query…</div>}
        {!loading && !error && !plot && data && (
          <div className="empty" style={{ margin: "auto" }}>
            {!data.rows.length ? "The query returned no rows" : !numericColumns.length ? "Nothing numeric to plot" : "Every numeric column is on the X axis — pick a different X"}
          </div>
        )}
        {plot && (
          <>
            <Plot data={plot} form={tab.form} width={size.width} height={size.height - (plot.series.length > 1 ? 24 : 0)} svgRef={svg} />
            {tab.form === "donut" ? <Legend names={plot.labels.slice(0, MAX_SERIES)} /> : <Legend names={plot.series.map((s) => s.name)} />}
          </>
        )}
      </div>

      {tab.showTable && data && (
        <div className="charttable">
          <table>
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c.name}>{c.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.slice(0, 100).map((r, i) => (
                <tr key={i}>
                  {r.map((v, j) => (
                    <td key={j} className={numeric(columns[j]) ? "num" : ""}>
                      {j === 0 && tab.form === "donut" && <i className="swatch" style={{ background: seriesColor(i) }} />}
                      {cellText(v, columns[j]?.logical ?? "text")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
