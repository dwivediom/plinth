import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Background, BackgroundVariant, Controls, Handle, Position, ReactFlow, type Edge, type Node, type NodeProps, type ReactFlowInstance } from "@xyflow/react";
import dagre from "@dagrejs/dagre";
import { Search, Table2, X } from "lucide-react";
import "@xyflow/react/dist/style.css";
import type { GraphNode, SchemaGraph } from "../../ipc/types";
import { adjacency, key, neighbours } from "../../lib/graph";
import { formatCount } from "../../lib/format";
import { useGraph } from "../../state/graph";
import type { MapTab } from "../../state/types";
import { useWorkspaces } from "../../state/workspaces";

/** Columns shown on a node before it says "+N more" — a node is a signpost, not a table. */
const PEEK = 6;
const NODE_WIDTH = 190;
const ROW_HEIGHT = 15;

interface TableNodeData extends Record<string, unknown> {
  node: GraphNode;
  /** Columns that carry a relationship, so the eye can follow the edges. */
  linked: Set<string>;
  dimmed: boolean;
  onOpen: () => void;
}

function height(n: GraphNode): number {
  return 34 + Math.min(n.columns.length, PEEK) * ROW_HEIGHT + (n.columns.length > PEEK ? ROW_HEIGHT : 0);
}

function TableNode({ data }: NodeProps) {
  const { node, linked, dimmed, onOpen } = data as TableNodeData;
  const extra = node.columns.length - PEEK;
  return (
    <div className={`mapnode${dimmed ? " dim" : ""}`} onDoubleClick={onOpen} title={`${node.table.schema ?? ""}.${node.table.name} — double-click to open`}>
      <Handle type="target" position={Position.Left} />
      <div className="h">
        <Table2 />
        <span className="n">{node.table.name}</span>
        {node.rowEstimate != null && <span className="r">{formatCount(node.rowEstimate)}</span>}
      </div>
      <div className="cols">
        {node.columns.slice(0, PEEK).map((c) => (
          <div key={c} className={linked.has(c.toLowerCase()) ? "c fk" : "c"}>
            {c}
          </div>
        ))}
        {extra > 0 && <div className="c more">+{extra} more</div>}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { table: TableNode };

/** Dagre, left to right — a schema reads as flow, not as a blob. */
function layout(graph: SchemaGraph, visible: Set<string>): Map<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 24, ranksep: 90 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of graph.nodes) {
    const k = key(n.table);
    if (!visible.has(k)) continue;
    g.setNode(k, { width: NODE_WIDTH, height: height(n) });
  }
  for (const e of graph.edges) {
    const a = key(e.from);
    const b = key(e.to);
    if (visible.has(a) && visible.has(b)) g.setEdge(a, b);
  }
  dagre.layout(g);
  const out = new Map<string, { x: number; y: number }>();
  for (const k of g.nodes()) {
    const n = g.node(k);
    if (n) out.set(k, { x: n.x - NODE_WIDTH / 2, y: n.y - n.height / 2 });
  }
  return out;
}

export function SchemaMap({ workspaceId, tabId }: { workspaceId: string; tabId: string }) {
  const tab = useWorkspaces((s) => s.byId[workspaceId]?.tabs.find((t) => t.id === tabId)) as MapTab | undefined;
  const updateTab = useWorkspaces((s) => s.updateTab);
  const openObject = useWorkspaces((s) => s.openObject);
  const graph = useGraph((s) => s.byWorkspace[workspaceId] ?? null);
  const loading = useGraph((s) => s.loading[workspaceId] ?? false);
  const error = useGraph((s) => s.error[workspaceId] ?? null);
  const load = useGraph((s) => s.load);
  const [filter, setFilter] = useState(tab?.filter ?? "");
  const flow = useRef<ReactFlowInstance | null>(null);

  useEffect(() => {
    void load(workspaceId);
  }, [load, workspaceId]);

  // Persist the filter lazily — it is tab state like a query's text.
  useEffect(() => {
    if (!tab || tab.filter === filter) return;
    const t = setTimeout(() => updateTab<MapTab>(workspaceId, tabId, { filter }), 400);
    return () => clearTimeout(t);
  }, [filter, tab, updateTab, workspaceId, tabId]);

  const openTable = useCallback(
    (n: GraphNode) => openObject(workspaceId, { schema: n.table.schema, name: n.table.name, kind: n.kind }),
    [openObject, workspaceId],
  );

  // Clicking a table isolates its neighbourhood: everything it reaches, and
  // everything that reaches it, at full strength — the rest recedes. Click the
  // canvas to let the whole schema back.
  const [focused, setFocused] = useState<string | null>(null);

  const { nodes, edges, hidden } = useMemo(() => {
    if (!graph) return { nodes: [] as Node[], edges: [] as Edge[], hidden: 0 };
    const adj = adjacency(graph);
    const q = filter.trim().toLowerCase();

    // A filter keeps matches *and their neighbours*: a table alone on screen
    // tells you nothing about how it is reached.
    let visible = new Set(graph.nodes.map((n) => key(n.table)));
    if (q) {
      const hits = graph.nodes.filter((n) => n.table.name.toLowerCase().includes(q) || (n.table.schema ?? "").toLowerCase().includes(q) || n.columns.some((c) => c.toLowerCase().includes(q)));
      visible = new Set(hits.map((n) => key(n.table)));
      for (const h of hits) for (const nb of neighbours(graph, key(h.table), adj)) visible.add(nb);
    }
    let direct = q ? new Set(graph.nodes.filter((n) => n.table.name.toLowerCase().includes(q) || n.columns.some((c) => c.toLowerCase().includes(q))).map((n) => key(n.table))) : visible;
    if (focused && visible.has(focused)) {
      direct = new Set([focused, ...neighbours(graph, focused, adj)]);
    }

    const linkedColumns = new Map<string, Set<string>>();
    for (const e of graph.edges) {
      for (const [t, cols] of [
        [key(e.from), e.fromColumns],
        [key(e.to), e.toColumns],
      ] as const) {
        const set = linkedColumns.get(t) ?? new Set<string>();
        for (const c of cols) set.add(c.toLowerCase());
        linkedColumns.set(t, set);
      }
    }

    const positions = layout(graph, visible);
    const flowNodes: Node[] = graph.nodes
      .filter((n) => visible.has(key(n.table)))
      .map((n) => {
        const k = key(n.table);
        return {
          id: k,
          type: "table",
          position: positions.get(k) ?? { x: 0, y: 0 },
          data: { node: n, linked: linkedColumns.get(k) ?? new Set(), dimmed: !direct.has(k), onOpen: () => openTable(n) } satisfies TableNodeData,
        };
      });

    const flowEdges: Edge[] = graph.edges
      .filter((e) => visible.has(key(e.from)) && visible.has(key(e.to)))
      .map((e, i) => ({
        id: `e${i}`,
        source: key(e.from),
        target: key(e.to),
        animated: false,
        // A guess looks like a guess.
        style: {
          ...(e.inferred ? { strokeDasharray: "4 3", stroke: "var(--label-3)" } : { stroke: "var(--accent)" }),
          ...(focused && key(e.from) !== focused && key(e.to) !== focused ? { opacity: 0.18 } : {}),
        },
        label: e.fromColumns.join(", "),
        labelShowBg: false,
        title: e.inferred ? "Inferred from naming — not a declared constraint" : (e.name ?? "Foreign key"),
      }));

    return { nodes: flowNodes, edges: flowEdges, hidden: graph.nodes.length - flowNodes.length };
  }, [graph, filter, openTable, focused]);

  // `fitView` on the element only applies at mount, so re-frame whenever the
  // filter changes what is on screen — otherwise clearing a filter leaves the
  // rest of the schema off-canvas.
  useEffect(() => {
    if (!nodes.length) return;
    const t = setTimeout(() => void flow.current?.fitView({ padding: 0.15, duration: 200 }), 50);
    return () => clearTimeout(t);
  }, [nodes.length, filter]);

  const inferred = graph?.edges.filter((e) => e.inferred).length ?? 0;

  return (
    <div className="schemamap">
      <div className="mapbar">
        <div className="field">
          <span className="glyph">
            <Search />
          </span>
          <input value={filter} placeholder="Filter tables and columns" aria-label="Filter the map" onChange={(e) => setFilter(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setFilter("")} />
          {filter && (
            <button className="clear" aria-label="Clear filter" onClick={() => setFilter("")}>
              <X />
            </button>
          )}
        </div>
        <span className="stat">
          {graph ? `${graph.nodes.length} tables · ${graph.edges.length} links` : loading ? "Reading the schema…" : ""}
          {inferred > 0 && <em title="Guessed from column naming, shown as dashed lines"> · {inferred} inferred</em>}
          {hidden > 0 && <em> · {hidden} hidden by filter</em>}
        </span>
        <button className="btn" onClick={() => void load(workspaceId, true)} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      {error && <div className="errrow">{error}</div>}
      <div className="canvas">
        {!graph && !loading && !error && <div className="empty" style={{ margin: "auto" }}>No schema yet</div>}
        {graph && !nodes.length && <div className="empty" style={{ margin: "auto" }}>Nothing matches “{filter}”</div>}
        {!!nodes.length && (
          <ReactFlow
            onInit={(inst) => (flow.current = inst)}
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            fitView
            minZoom={0.1}
            proOptions={{ hideAttribution: false }}
            nodesDraggable
            nodesConnectable={false}
            elementsSelectable
            onNodeClick={(_, n) => setFocused((f) => (f === n.id ? null : n.id))}
            onPaneClick={() => setFocused(null)}
          >
            <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="var(--separator)" />
            <Controls showInteractive={false} />
          </ReactFlow>
        )}
      </div>
    </div>
  );
}
