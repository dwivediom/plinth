import type { ReactNode } from "react";

/**
 * The pictures in the tour.
 *
 * Each one is a drawing of a real pane of this app, in this app's own tokens
 * — same surfaces, same hairlines, same syntax palette, same chart colours.
 * They are SVG rather than screenshots so they stay sharp, follow the theme,
 * and cost nothing to ship. Motion is CSS; `prefers-reduced-motion` already
 * turns all of it off globally.
 */

const W = 520;
const H = 280;

function Frame({ title, bar, children }: { title: string; bar: ReactNode; children: ReactNode }) {
  return (
    <svg className="shot" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title} preserveAspectRatio="xMidYMid meet">
      <rect className="pane" x="0.5" y="0.5" width={W - 1} height={H - 1} rx="10" />
      <path className="bar" d={`M0.5 10.5a10 10 0 0 1 10-10h${W - 21}a10 10 0 0 1 10 10V28.5H0.5Z`} />
      <path className="hair" d={`M0.5 28.5H${W - 0.5}`} />
      {bar}
      {children}
    </svg>
  );
}

/** A toolbar pill. */
function Pill({ x, y, w, label, tone }: { x: number; y: number; w: number; label: string; tone?: string }) {
  return (
    <g className={tone ? `pill ${tone}` : "pill"}>
      <rect x={x} y={y} width={w} height="16" rx="5" />
      <text x={x + w / 2} y={y + 11} textAnchor="middle">
        {label}
      </text>
    </g>
  );
}

// ───────────────────────────── 1. the AI ─────────────────────────────

export function AskShot() {
  const steps = [
    { n: "1", think: "First, what counts as churn here?", act: "inspect · public.subscriptions" },
    { n: "2", think: "Cancelled last month, no restart since.", act: "probe · SELECT count(*) … GROUP BY reason" },
    { n: "3", think: "Check the number against a second angle.", act: "verify · 412 rows, two ways" },
  ];
  return (
    <Frame
      title="The AI pane working in steps"
      bar={
        <>
          <text className="t2" x="12" y="19">
            AI
          </text>
          <Pill x={404} y={7} w={104} label="llama3.1 · local" tone="ok" />
        </>
      }
    >
      <g className="bubble reveal" style={{ ["--i" as string]: 0 }}>
        <rect x="236" y="42" width="272" height="26" rx="8" />
        <text x="250" y="59">why did revenue dip in March?</text>
      </g>

      {steps.map((s, i) => (
        <g key={s.n} className="step reveal" style={{ ["--i" as string]: i + 1 }}>
          <circle className="idx" cx="24" cy={94 + i * 46} r="8" />
          <text className="idxn" x="24" y={97 + i * 46} textAnchor="middle">
            {s.n}
          </text>
          <text className="t1" x="42" y={91 + i * 46}>
            {s.think}
          </text>
          <text className="m t3" x="42" y={107 + i * 46}>
            {s.act}
          </text>
        </g>
      ))}

      <g className="answer reveal" style={{ ["--i" as string]: 4 }}>
        <path className="hair" d="M12 232.5H508" />
        <path className="tick" d="M16 250l5 5 9-10" />
        <text className="t1" x="40" y="254">
          Three refund waves, all from one merchant — 412 orders, €38,900.
        </text>
      </g>
    </Frame>
  );
}

// ─────────────────────────── 2. the rails ────────────────────────────

export function RailsShot() {
  return (
    <Frame
      title="A write being stopped before it runs"
      bar={
        <>
          <text className="t2" x="12" y="19">
            production · app
          </text>
          <Pill x={416} y={7} w={92} label="safe mode on" tone="warn" />
        </>
      }
    >
      <text className="m" x="16" y="58">
        <tspan className="tok-kw">DELETE</tspan> <tspan className="tok-kw">FROM</tspan> <tspan className="tok-type">orders</tspan>
        <tspan className="tok-punct">;</tspan>
      </text>
      <path className="squiggle" d="M16 64q4 4 8 0t8 0 8 0 8 0 8 0 8 0 8 0 8 0 8 0 8 0 8 0 8 0 8 0" />

      <g className="card reveal" style={{ ["--i" as string]: 1 }}>
        <rect x="16" y="86" width="488" height="152" rx="10" />
        <path className="warnring" d="M40 112a12 12 0 1 1 0.01 0" />
        <path className="bang" d="M40 106v7M40 117.5v0.5" />
        <text className="t0" x="62" y="111">
          This deletes every row in orders.
        </text>
        <text className="t2" x="62" y="129">
          No WHERE clause. 4,182,003 rows would go.
        </text>

        <text className="t2" x="62" y="159">
          Type
          <tspan className="m t0" dx="5">orders</tspan>
          <tspan dx="5">to confirm:</tspan>
        </text>
        <rect className="input" x="62" y="168" width="200" height="24" rx="6" />
        <g clipPath="url(#typing)">
          <text className="m t0" x="72" y="184">
            orders
          </text>
        </g>
        <rect className="caret" x="104" y="172" width="1.5" height="16" />
        <clipPath id="typing">
          <rect className="typeclip" x="70" y="170" width="40" height="20" />
        </clipPath>

        <g className="btn ghost">
          <rect x="330" y="168" width="72" height="24" rx="6" />
          <text x="366" y="184" textAnchor="middle">
            Cancel
          </text>
        </g>
        <g className="btn danger">
          <rect x="412" y="168" width="76" height="24" rx="6" />
          <text x="450" y="184" textAnchor="middle">
            Delete
          </text>
        </g>
        <text className="t3" x="62" y="218">
          Classified by a SQL parser, not a regex — WITH … DELETE is caught too.
        </text>
      </g>
    </Frame>
  );
}

// ────────────────────────── 3. the schema map ─────────────────────────

const NODES = [
  { x: 24, y: 58, name: "customers", cols: ["id", "email"] },
  { x: 200, y: 44, name: "orders", cols: ["id", "customer_id"] },
  { x: 376, y: 40, name: "payments", cols: ["id", "order_id"] },
  { x: 376, y: 150, name: "refunds", cols: ["id", "order_id"] },
  { x: 200, y: 164, name: "order_items", cols: ["order_id", "sku"] },
];

export function MapShot() {
  return (
    <Frame
      title="Tables laid out by their foreign keys"
      bar={
        <>
          <text className="t2" x="12" y="19">
            Map · public
          </text>
          <Pill x={392} y={7} w={116} label="9 keys · 2 inferred" />
        </>
      }
    >
      <path className="edge flow" d="M134 82h30q12 0 12-12v-4h24" />
      <path className="edge" d="M310 74h30q12 0 12-6v-6h24" />
      <path className="edge" d="M310 90h30q12 0 12 14v66h24" />
      <path className="edge dashed" d="M264 118v34q0 12 0 12" />

      {NODES.map((n) => (
        <g key={n.name} className={`node reveal${n.name === "orders" ? " on" : ""}`} style={{ ["--i" as string]: NODES.indexOf(n) }}>
          <rect x={n.x} y={n.y} width="110" height="56" rx="7" />
          <path className="hair" d={`M${n.x}.5 ${n.y + 20}.5h109`} />
          <text className="t0" x={n.x + 10} y={n.y + 14}>
            {n.name}
          </text>
          {n.cols.map((c, i) => (
            <text key={c} className="t3 m" x={n.x + 10} y={n.y + 35 + i * 14}>
              {c}
            </text>
          ))}
        </g>
      ))}

      <g className="legend">
        <path className="edge" d="M24 244h22" />
        <text className="t3" x="52" y="248">
          declared
        </text>
        <path className="edge dashed" d="M116 244h22" />
        <text className="t3" x="144" y="248">
          inferred from naming — never presented as fact
        </text>
      </g>
    </Frame>
  );
}

// ───────────────────────── 4. the query plan ──────────────────────────

const PLAN = [
  { x: 186, y: 44, type: "Hash Join", rel: "customer_id", heat: 12, step: 2, ms: "1.2 ms" },
  { x: 40, y: 128, type: "Seq Scan", rel: "orders", heat: 74, step: 5, ms: "612 ms", flag: true },
  { x: 318, y: 128, type: "Hash", rel: "customers", heat: 9, step: 2, ms: "74 ms" },
  { x: 318, y: 206, type: "Index Scan", rel: "customers_pkey", heat: 4, step: 1, ms: "31 ms" },
];

export function ExplainShot() {
  return (
    <Frame
      title="A query plan shaded by self time"
      bar={
        <>
          <text className="t2" x="12" y="19">
            Executed plan · 718 ms
          </text>
          <Pill x={368} y={7} w={140} label="analysed on this machine" tone="ok" />
        </>
      }
    >
      <path className="edge thick" d="M240 100v14q0 8-8 8H108q-8 0-8 8v-2" />
      <path className="edge" d="M280 100v14q0 8 8 8h84q8 0 8 8v-2" />
      <path className="edge" d="M378 184v22" />

      {PLAN.map((n, i) => (
        <g key={n.type} className="plannode reveal" style={{ ["--i" as string]: i }}>
          <rect x={n.x} y={n.y} width="162" height="56" rx="7" />
          <text className="t0" x={n.x + 10} y={n.y + 17}>
            {n.type}
          </text>
          {n.flag && <path className="flagtri" d={`M${n.x + 142} ${n.y + 22}l6 11h-12z`} />}
          <text className="t3" x={n.x + 10} y={n.y + 31}>
            {n.rel}
          </text>
          <rect className="meterbg" x={n.x + 10} y={n.y + 38} width="142" height="4" rx="2" />
          <rect className="meter" x={n.x + 10} y={n.y + 38} width={(142 * n.heat) / 100} height="4" rx="2" style={{ fill: `var(--heat-${n.step})` }} />
          <text className="t3 num" x={n.x + 152} y={n.y + 17} textAnchor="end">
            {n.ms}
          </text>
        </g>
      ))}

      <g className="hazard reveal" style={{ ["--i" as string]: 4 }}>
        <rect x="24" y="200" width="270" height="56" rx="8" />
        <path className="flagtri" d="M40 214l7 12h-14z" />
        <text className="t0" x="58" y="219">
          Sequential scan · serious
        </text>
        <text className="t3" x="40" y="236">
          orders is read end to end — 4.2M rows.
        </text>
        <text className="t3" x="40" y="249">
          An index on placed_at would skip most of them.
        </text>
      </g>
    </Frame>
  );
}

// ───────────────────────────── 5. the diff ────────────────────────────

const DIFFS = [
  { k: "add", left: "—", right: "orders.discount_cents", note: "integer not null default 0" },
  { k: "chg", left: "users.last_seen  timestamp", right: "timestamptz", note: "type differs" },
  { k: "del", left: "legacy_carts", right: "—", note: "table only on staging" },
  { k: "idx", left: "—", right: "orders_placed_at_idx", note: "index" },
];

export function DiffShot() {
  return (
    <Frame
      title="Two schemas compared, with the migration written out"
      bar={
        <>
          <text className="t2" x="12" y="19">
            staging
          </text>
          <text className="t3" x="66" y="19">
            ⇄
          </text>
          <text className="t2" x="84" y="19">
            production
          </text>
          <Pill x={424} y={7} w={84} label="4 differences" tone="warn" />
        </>
      }
    >
      {DIFFS.map((d, i) => (
        <g key={d.left} className={`drow reveal ${d.k}`} style={{ ["--i" as string]: i }}>
          <rect x="12" y={42 + i * 30} width="496" height="26" rx="6" />
          <text className="sign" x="24" y={59 + i * 30}>
            {d.k === "add" || d.k === "idx" ? "+" : d.k === "del" ? "−" : "~"}
          </text>
          <text className="m t0" x="40" y={59 + i * 30}>
            {d.k === "chg" ? d.left : d.k === "del" ? d.left : d.right}
          </text>
          <text className="t3" x="330" y={59 + i * 30}>
            {d.note}
          </text>
        </g>
      ))}

      <g className="code reveal" style={{ ["--i" as string]: 4 }}>
        <rect x="12" y="172" width="496" height="92" rx="8" />
        <text className="m" x="26" y="194">
          <tspan className="tok-kw">ALTER TABLE</tspan> <tspan className="tok-type">orders</tspan> <tspan className="tok-kw">ADD COLUMN</tspan> discount_cents <tspan className="tok-type">integer</tspan>
          <tspan className="tok-punct">;</tspan>
        </text>
        <text className="m" x="26" y="214">
          <tspan className="tok-kw">CREATE INDEX</tspan> orders_placed_at_idx <tspan className="tok-kw">ON</tspan> <tspan className="tok-type">orders</tspan> (placed_at)
          <tspan className="tok-punct">;</tspan>
        </text>
        <text className="m tok-cmt" x="26" y="240">
          -- DROP TABLE legacy_carts; -- destructive: uncomment on purpose
        </text>
      </g>
    </Frame>
  );
}

// ───────────────────────────── 6. the chart ───────────────────────────

const BARS = [
  { l: "Mon", v: 62 },
  { l: "Tue", v: 88 },
  { l: "Wed", v: 74 },
  { l: "Thu", v: 130 },
  { l: "Fri", v: 108 },
  { l: "Sat", v: 46 },
  { l: "Sun", v: 34 },
];

export function ChartShot() {
  const base = 226;
  return (
    <Frame
      title="A bar chart exporting as a transparent PNG"
      bar={
        <>
          <text className="t2" x="12" y="19">
            Chart · orders per day
          </text>
          <Pill x={392} y={7} w={116} label="Transparent PNG 2×" />
        </>
      }
    >
      {[0, 1, 2].map((g) => (
        <path key={g} className="hair" d={`M40 ${base - g * 56}.5H500`} />
      ))}
      {BARS.map((b, i) => (
        <g key={b.l} className="bar reveal" style={{ ["--i" as string]: i }}>
          <rect x={52 + i * 64} y={base - b.v} width="44" height={b.v} rx="4" />
          <text className="t3 num" x={74 + i * 64} y={base - b.v - 8} textAnchor="middle">
            {b.v}
          </text>
          <text className="t3" x={74 + i * 64} y={base + 16} textAnchor="middle">
            {b.l}
          </text>
        </g>
      ))}
      <path className="hair" d={`M40 ${base}.5H500`} />
      <g className="alpha">
        <pattern id="checker" width="8" height="8" patternUnits="userSpaceOnUse">
          <rect width="4" height="4" />
          <rect x="4" y="4" width="4" height="4" />
        </pattern>
        <rect x="406" y="40" width="98" height="24" rx="6" fill="url(#checker)" />
        <text className="t3" x="455" y="55" textAnchor="middle">
          no background
        </text>
      </g>
    </Frame>
  );
}

// ──────────────────────────── 7. embeddings ───────────────────────────

const SPARK = "M0 20L8 14 16 24 24 9 32 22 40 6 48 26 56 12 64 19 72 4 80 21 88 15 96 25 104 10 112 18 120 8";

export function VectorShot() {
  return (
    <Frame
      title="A pgvector column shown as a fingerprint"
      bar={
        <>
          <text className="t2" x="12" y="19">
            public.documents
          </text>
          <Pill x={404} y={7} w={104} label="halfvec · decoded" tone="ok" />
        </>
      }
    >
      <text className="t3" x="16" y="50">
        id
      </text>
      <text className="t3" x="52" y="50">
        title
      </text>
      <text className="t3" x="250" y="50">
        embedding
      </text>
      <path className="hair" d="M12 58.5H508" />

      {[0, 1].map((r) => (
        <g key={r} className="vrow reveal" style={{ ["--i" as string]: r }}>
          <text className="m t2" x="16" y={82 + r * 44}>
            {r + 1}
          </text>
          <text className="t0" x="52" y={82 + r * 44}>
            {r === 0 ? "Refund policy, EU" : "Shipping windows"}
          </text>
          <g transform={`translate(246 ${62 + r * 44}) scale(0.88 1)`}>
            <path className={`spark s${r + 1}`} d={SPARK} />
          </g>
          <g className="tinychip">
            <rect x="374" y={68 + r * 44} width="44" height="16" rx="5" />
            <text x="396" y={79 + r * 44} textAnchor="middle">
              1536d
            </text>
          </g>
          <g className="tinychip">
            <rect x="424" y={68 + r * 44} width="72" height="16" rx="5" />
            <text x="460" y={79 + r * 44} textAnchor="middle">
              {r === 0 ? "norm 1.00" : "norm 7.42"}
            </text>
          </g>
        </g>
      ))}

      <g className="code reveal" style={{ ["--i" as string]: 2 }}>
        <rect x="12" y="150" width="496" height="114" rx="8" />
        <text className="m tok-cmt" x="26" y="172">
          -- Nearest neighbours by cosine distance.
        </text>
        <text className="m" x="26" y="192">
          <tspan className="tok-kw">SELECT</tspan> t.id, t.title, t.embedding <tspan className="tok-op">&lt;=&gt;</tspan>
        </text>
        <text className="m" x="26" y="212">
          {"  "}(<tspan className="tok-kw">SELECT</tspan> embedding <tspan className="tok-kw">FROM</tspan> <tspan className="tok-type">documents</tspan> <tspan className="tok-kw">WHERE</tspan> id <tspan className="tok-op">=</tspan> <tspan className="tok-num">1</tspan>) <tspan className="tok-kw">AS</tspan> distance
        </text>
        <text className="m" x="26" y="232">
          <tspan className="tok-kw">FROM</tspan> <tspan className="tok-type">documents</tspan> t <tspan className="tok-kw">ORDER BY</tspan> distance <tspan className="tok-kw">LIMIT</tspan> <tspan className="tok-num">20</tspan>
          <tspan className="tok-punct">;</tspan>
        </text>
        <text className="t3" x="26" y="254">
          Written for you from the row you right-clicked — anchored by key, not 1,536 literals.
        </text>
      </g>
    </Frame>
  );
}

// ───────────────────────────── 8. the editor ──────────────────────────

export function EditorShot() {
  const rows = [
    { l: "customers ON orders.customer_id = customers.id", d: "foreign key", on: true },
    { l: "customer_events", d: "public · ~2.1M rows", on: false },
    { l: "customer_tiers", d: "public · ~9 rows", on: false },
  ];
  return (
    <Frame
      title="Schema-aware completion in the editor"
      bar={
        <>
          <text className="t2" x="12" y="19">
            Query · prod-rds
          </text>
          <Pill x={416} y={7} w={92} label="⌘↵ to run" />
        </>
      }
    >
      <text className="m t3" x="16" y="56">
        1
      </text>
      <text className="m" x="36" y="56">
        <tspan className="tok-kw">SELECT</tspan> <tspan className="tok-column">o.id</tspan>
        <tspan className="tok-punct">,</tspan> <tspan className="tok-column">o.amount</tspan>
        <tspan className="tok-punct">,</tspan> <tspan className="tok-fn">sum</tspan>
        <tspan className="rb1">(</tspan>
        <tspan className="tok-column">r.cents</tspan>
        <tspan className="rb1">)</tspan>
      </text>
      <text className="m t3" x="16" y="76">
        2
      </text>
      <text className="m" x="36" y="76">
        <tspan className="tok-kw">FROM</tspan> <tspan className="tok-table">orders</tspan> o
      </text>
      <text className="m t3" x="16" y="96">
        3
      </text>
      <text className="m" x="36" y="96">
        <tspan className="tok-kw">JOIN</tspan> cust
      </text>
      <rect className="caret" x="106" y="84" width="1.5" height="15" />

      <g className="pop reveal" style={{ ["--i" as string]: 1 }}>
        <rect x="90" y="106" width="400" height="98" rx="8" />
        {rows.map((r, i) => (
          <g key={r.l} className={r.on ? "prow on" : "prow"}>
            <rect x="96" y={112 + i * 30} width="388" height="26" rx="5" />
            <text className="ic" x="110" y={129 + i * 30}>
              {i === 0 ? "⌁" : "▤"}
            </text>
            <text className="m" x="128" y={129 + i * 30}>
              {r.l}
            </text>
            <text className="d" x="474" y={129 + i * 30} textAnchor="end">
              {r.d}
            </text>
          </g>
        ))}
      </g>
      <text className="t3" x="16" y="232">
        The whole clause, built from the foreign-key graph and ranked first.
      </text>
      <text className="t3" x="16" y="250">
        A name that is a table reads as a table; a column reads as a column.
      </text>
    </Frame>
  );
}

export const SHOTS: Record<string, () => React.JSX.Element> = {
  ask: AskShot,
  rails: RailsShot,
  explain: ExplainShot,
  map: MapShot,
  diff: DiffShot,
  chart: ChartShot,
  vector: VectorShot,
  editor: EditorShot,
};
