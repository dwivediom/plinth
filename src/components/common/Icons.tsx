import { Bookmark, ChartColumn, Eye, GitCompare, Hash, Layers, Network, ScrollText, SquareFunction, Table2, Waypoints , Braces } from "lucide-react";
import type { ObjectKind } from "../../ipc/types";
import type { TabKind } from "../../state/types";

export function ObjectIcon({ kind }: { kind: ObjectKind }) {
  switch (kind) {
    case "view":
      return <Eye />;
    case "materialized-view":
      return <Layers />;
    case "function":
      return <SquareFunction />;
    case "sequence":
      return <Hash />;
    default:
      return <Table2 />;
  }
}

export function TabIcon({ kind, objectKind }: { kind: TabKind; objectKind?: ObjectKind }) {
  if (kind === "table") return <ObjectIcon kind={objectKind ?? "table"} />;
  if (kind === "saved") return <Bookmark />;
  if (kind === "map") return <Network />;
  if (kind === "chart") return <ChartColumn />;
  if (kind === "diff") return <GitCompare />;
  if (kind === "plan") return <Waypoints />;
  if (kind === "json") return <Braces />;
  return <ScrollText />;
}
