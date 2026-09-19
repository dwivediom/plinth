import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Background, BackgroundVariant, Controls, Handle, Position, ReactFlow, type Edge, type Node, type NodeProps, type ReactFlowInstance } from "@xyflow/react";
import dagre from "@dagrejs/dagre";
import { AlertTriangle, Check, Copy, Gauge, Info, Lock, OctagonAlert } from "lucide-react";
import "@xyflow/react/dist/style.css";
import { DETAIL_FIELDS, formatMs, formatRows, parsePlan, type Hazard, type ParsedPlan, type PlanNode, type Severity } from "../../lib/explain";
import type { PlanTab } from "../../state/types";
import { useWorkspaces } from "../../state/workspaces";
import { describeGain, improvement, MATERIAL, type Candidate } from "../../lib/optimize";
import { toast } from "../../state/overlays";
import { guardWrite } from "../../lib/writeGate";
import { errorMessage, invoke } from "../../ipc/client";
import { policyWayOut } from "../../lib/policyWayOut";

const NODE_WIDTH = 210;
const NODE_HEIGHT = 74;

const SEVERITY: Record<Severity, { icon: React.ReactNode; label: string }> = {
  serious: { icon: <OctagonAlert />, label: "serious" },
  warn: { icon: <AlertTriangle />, label: "warning" },
  info: { icon: <Info />, label: "note" },
};

interface CardData extends Record<string, unknown> {
  node: PlanNode;
  /** Self time as a share of the whole run, 0–1. */
  heat: number;
  worst: Severity | null;
  selected: boolean;
}

/**
 * One node. The bar is **self** time as a share of the run — the number that
 * says where the time went, rather than the inclusive time that paints every
 * parent red.
 */
function PlanCard({ data }: NodeProps) {
  const { node, heat, worst, selected } = data as CardData;
  // Five steps of one hue, validated against this app's surfaces in both
  // modes. Heat is magnitude, so it is a ramp — never a rainbow.
  const step = heat >= 0.4 ? 5 : heat >= 0.25 ? 4 : heat >= 0.12 ? 3 : heat >= 0.04 ? 2 : 1;
  return (
    <div className={`plannode${selected ? " on" : ""}${worst ? ` ${worst}` : ""}`} title={`${node.label} · self ${formatMs(node.selfMs)}`}>
      <Handle type="target" position={Position.Top} />
      <div className="h">
        <span className="t">{node.type}</span>
        {node.loops > 1 && <span className="loops">×{formatRows(node.loops)}</span>}
        {worst && <span className="flag">{SEVERITY[worst].icon}</span>}
      </div>
      {node.relation && <div className="rel">{node.relation}</div>}
      <div className="meter" aria-hidden>
        <i style={{ width: `${Math.max(2, heat * 100)}%`, background: `var(--heat-${step})` }} />
      </div>
      <div className="f">
        <span>{formatMs(node.selfMs)}</span>
        <span className="rows">
          {formatRows(node.rows)}
          {node.estimateFactor != null && node.estimateFactor >= 10 && <em> vs {formatRows(node.plannedRows)}</em>}
        </span>
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

const nodeTypes = { plan: PlanCard };

function layout(nodes: PlanNode[]): Map<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "TB", nodesep: 26, ranksep: 54 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  // Root on top, children beneath: a plan reads as "the final step, and
  // what fed it", which is how every other plan viewer lays it out.
  for (const n of nodes) for (const c of n.children) g.setEdge(n.id, c.id);
  dagre.layout(g);
  const out = new Map<string, { x: number; y: number }>();
  for (const id of g.nodes()) {
    const n = g.node(id);
    if (n) out.set(id, { x: n.x - NODE_WIDTH / 2, y: n.y - NODE_HEIGHT / 2 });
  }
  return out;
}

export function PlanView({ workspaceId, tabId }: { workspaceId: string; tabId: string }) {
  const tab = useWorkspaces((s) => s.byId[workspaceId]?.tabs.find((t) => t.id === tabId)) as PlanTab | undefined;
  const [selected, setSelected] = useState<string | null>(null);
  const flow = useRef<ReactFlowInstance | null>(null);

  const parsed: ParsedPlan | null = useMemo(() => (tab?.planJson ? parsePlan(tab.planJson) : null), [tab?.planJson]);

  const focus = useCallback((nodeId: string) => {
    setSelected(nodeId);
    const rf = flow.current;
    const node = rf?.getNode(nodeId);
    if (rf && node) void rf.setCenter(node.position.x + NODE_WIDTH / 2, node.position.y + NODE_HEIGHT / 2, { zoom: 1.1, duration: 300 });
  }, []);

  const { nodes, edges } = useMemo(() => {
    if (!parsed) return { nodes: [] as Node[], edges: [] as Edge[] };
    const positions = layout(parsed.nodes);
    const worstBy = new Map<string, Severity>();
    for (const h of parsed.hazards) {
      const current = worstBy.get(h.nodeId);
      const rank: Record<Severity, number> = { serious: 0, warn: 1, info: 2 };
      if (!current || rank[h.severity] < rank[current]) worstBy.set(h.nodeId, h.severity);
    }

    const rowsMax = Math.max(1, ...parsed.nodes.map((n) => n.rows ?? 0));
    const flowNodes: Node[] = parsed.nodes.map((n) => ({
      id: n.id,
      type: "plan",
      position: positions.get(n.id) ?? { x: 0, y: 0 },
      data: {
        node: n,
        heat: parsed.totalMs > 0 ? n.selfMs / parsed.totalMs : 0,
        worst: worstBy.get(n.id) ?? null,
        selected: selected === n.id,
      } satisfies CardData,
    }));

    const flowEdges: Edge[] = parsed.nodes.flatMap((n) =>
      n.children.map((c) => ({
        id: `${n.id}->${c.id}`,
        source: n.id,
        target: c.id,
        // Width follows the rows flowing through, on a log scale: the fat pipe
        // is the one carrying the data.
        style: { stroke: "var(--label-4)", strokeWidth: 1 + (Math.log10(1 + (c.rows ?? 0)) / Math.log10(1 + rowsMax)) * 5 },
        label: (c.rows ?? 0) > 0 ? formatRows(c.rows) : undefined,
        labelShowBg: false,
      })),
    );
    return { nodes: flowNodes, edges: flowEdges };
  }, [parsed, selected]);

  useEffect(() => {
    if (nodes.length) setTimeout(() => void flow.current?.fitView({ padding: 0.2, duration: 200 }), 60);
  }, [nodes.length]);

  if (!tab) return null;
  const node = parsed?.nodes.find((n) => n.id === selected) ?? null;

  return (
    <div className="planview">
      <div className="planbar">
        <span className="title">{parsed?.analyzed ? "Executed plan" : "Estimated plan"}</span>
        {parsed && (
          <>
            {parsed.executionMs != null && <span className="stat"><b>{formatMs(parsed.executionMs)}</b> execution</span>}
            {parsed.planningMs != null && <span className="stat"><b>{formatMs(parsed.planningMs)}</b> planning</span>}
            <span className="stat"><b>{parsed.nodes.length}</b> nodes</span>
            {!!parsed.hazards.length && <span className="stat warn"><b>{parsed.hazards.length}</b> to look at</span>}
          </>
        )}
        <span className="spacer" />
        <span className="local" title="The plan is parsed and analysed in this app. Nothing is uploaded.">
          <Lock /> analysed on this machine
        </span>
      </div>

      <div className="planbody">
        <div className="canvas">
          {!parsed && <div className="empty" style={{ margin: "auto" }}>No plan captured</div>}
          {!!nodes.length && (
            <ReactFlow
              onInit={(i) => (flow.current = i)}
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              fitView
              minZoom={0.2}
              nodesDraggable
              nodesConnectable={false}
              onNodeClick={(_, n) => setSelected(n.id)}
            >
              <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="var(--separator)" />
              <Controls showInteractive={false} />
            </ReactFlow>
          )}
          {parsed && (
            <div className="heatkey" aria-hidden>
              <span>share of runtime</span>
              {[1, 2, 3, 4, 5].map((s) => (
                <i key={s} style={{ background: `var(--heat-${s})` }} />
              ))}
              <span>most</span>
            </div>
          )}
        </div>

        <aside className="planside">
          {(tab.optimizing || tab.optimize) && <Optimizations workspaceId={workspaceId} tab={tab} />}
          {!!parsed?.hazards.length && (
            <div className="hazards">
              {parsed.hazards.map((h) => (
                <HazardRow key={h.id} hazard={h} onClick={() => focus(h.nodeId)} />
              ))}
            </div>
          )}
          {parsed && !parsed.hazards.length && <div className="none">Nothing stands out in this plan.</div>}
          {node && (
            <div className="fields">
              <div className="fh">{node.label}</div>
              {DETAIL_FIELDS.filter((f) => node.detail[f] !== undefined).map((f) => (
                <div className="fr" key={f}>
                  <span className="k">{f}</span>
                  <span className="v">{String(node.detail[f])}</span>
                </div>
              ))}
            </div>
          )}
          {!node && parsed && <div className="none pick">Pick a node to see everything the plan says about it.</div>}
        </aside>
      </div>
    </div>
  );
}

function HazardRow({ hazard, onClick }: { hazard: Hazard; onClick: () => void }) {
  return (
    <button className={`hazard ${hazard.severity}`} onClick={onClick}>
      <span className="i">{SEVERITY[hazard.severity].icon}</span>
      <span className="b">
        <b>
          {hazard.title}
          <em> · {SEVERITY[hazard.severity].label}</em>
        </b>
        <span>{hazard.detail}</span>
      </span>
    </button>
  );
}

/**
 * What would make it faster, and by how much — measured, not asserted.
 *
 * Every row here was put back through `EXPLAIN`: the percentage is the
 * planner's own answer to "what if this existed". A candidate that could not
 * be measured says so instead of borrowing the credibility of the ones that
 * could.
 */
function Optimizations({ workspaceId, tab }: { workspaceId: string; tab: PlanTab }) {
  const report = tab.optimize ?? null;
  if (tab.optimizing) {
    return (
      <div className="optimize working">
        <Gauge /> {tab.optimizing}…
      </div>
    );
  }
  if (!report) return null;
  const helpful = report.candidates.filter((c) => (improvement(c.baseCost, c.newCost) ?? 0) >= MATERIAL);
  const rest = report.candidates.filter((c) => !helpful.includes(c));

  /**
   * Create the index. Two things have to be true first: the policy has to
   * allow DDL, and a person has to have read the statement. If the policy
   * refuses, the notice carries the way through rather than leaving you to
   * find it — `CREATE INDEX` on a read-write connection is the exact case
   * one elevated run exists for.
   */
  const apply = async (c: Candidate, elevated = false) => {
    if (c.kind !== "index") return;
    const gate = await guardWrite(workspaceId, c.sql, { elevated });
    if (!gate.ok) return;
    try {
      const r = elevated
        ? await invoke("query_run_elevated", { workspaceId, sql: c.sql, limit: 1 })
        : await invoke("query_run", { workspaceId, sql: c.sql, limit: 1 });
      const err = r[0]?.error;
      if (!err) return toast(elevated ? "Created, with the policy lifted for that one statement. Re-run Optimize to see the new plan." : "Created. Re-run Optimize to see the new plan.");
      const way = err.blockedByPolicy ? policyWayOut(workspaceId, err.message, () => void apply(c, true)) : null;
      toast(err.message, "error", way ?? undefined);
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  return (
    <div className="optimize">
      <div className="oh">
        <Gauge /> <b>What would make this faster</b>
      </div>
      {report.bottleneck && <p className="obn">The plan is dominated by: {report.bottleneck}.</p>}
      {!report.candidates.length && <p className="obn">Nothing to suggest — no scan in this plan is filtering away enough rows to be worth an index.</p>}

      {report.candidates.map((c) => {
        const gain = improvement(c.baseCost, c.newCost);
        const good = (gain ?? 0) >= MATERIAL;
        return (
          <div className={`ocand${good ? " good" : ""}`} key={c.id}>
            <div className="ot">
              <span className="k">{c.kind === "index" ? "index" : "rewrite"}</span>
              <b>{c.title}</b>
              {gain != null ? (
                <span className={good ? "gain" : "flat"}>{good ? describeGain(c.baseCost, c.newCost) : "no improvement"}</span>
              ) : (
                <span className="flat">not measured</span>
              )}
            </div>
            <p>{c.why}</p>
            <pre className="selectable">{c.sql}</pre>
            {c.note && <p className="note">{c.note}</p>}
            {c.newCost != null && (
              <p className="note">
                Planner cost {Math.round(c.baseCost).toLocaleString()} → {Math.round(c.newCost).toLocaleString()}
                {c.kind === "index" && c.used === false ? " — the planner did not choose it" : ""}. An estimate, not a timing.
              </p>
            )}
            <div className="oa">
              <button className="btn mini" onClick={() => void navigator.clipboard.writeText(c.sql).then(() => toast("Copied"), () => toast("Could not reach the clipboard", "error"))}>
                <Copy /> Copy
              </button>
              {c.kind === "index" && (
                <button className="btn mini" onClick={() => void apply(c)}>
                  <Check /> Create it
                </button>
              )}
            </div>
          </div>
        );
      })}

      {!report.hypopg && !!report.candidates.length && (
        <p className="note hint">
          Install the <b>hypopg</b> extension and these are measured against the planner without building anything:
          <code>CREATE EXTENSION hypopg;</code>
        </p>
      )}
      {!!report.candidates.length && (
        <p className="note">
          {report.candidates.every((c) => c.newCost == null)
            ? "None of these could be measured on this server, so they are suggestions, not findings."
            : `${helpful.length} of ${report.candidates.length} measured as an improvement${rest.length ? "; the rest are shown so you can see they were tried" : ""}.`}
          {report.refusedRewrites > 0 && " The model's rewrite was refused by the server, so it is not shown."}
        </p>
      )}
    </div>
  );
}
