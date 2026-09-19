import { ChartView } from "../../components/chart/ChartView";
import { DiffView } from "../../components/diff/DiffView";
import { PlanView } from "../../components/plan/PlanView";
import { SchemaMap } from "../../components/map/SchemaMap";
import { TableView } from "../../components/grid/TableView";
import { QueryView } from "../../components/editor/QueryView";
import { chordLabel } from "../../lib/keys";
import { useWorkspaces } from "../../state/workspaces";
import { JsonTabView } from "../json/JsonTabView";

export function TabContent({ workspaceId }: { workspaceId: string }) {
  const tab = useWorkspaces((s) => s.byId[workspaceId]?.tabs.find((t) => t.id === s.byId[workspaceId]?.activeTabId));
  const openQuery = useWorkspaces((s) => s.openQuery);
  if (!tab) {
    return (
      <div className="empty" style={{ margin: "auto" }}>
        No Tabs Open
        <small>
          Pick a table in the sidebar, or press {chordLabel("Mod+T")} for a{" "}
          <button className="btn plain" style={{ display: "inline", padding: 0, height: "auto" }} onClick={() => openQuery(workspaceId)}>
            new query
          </button>
          .
        </small>
      </div>
    );
  }
  if (tab.kind === "table") return <TableView key={tab.id} workspaceId={workspaceId} tabId={tab.id} />;
  if (tab.kind === "map") return <SchemaMap key={tab.id} workspaceId={workspaceId} tabId={tab.id} />;
  if (tab.kind === "chart") return <ChartView key={tab.id} workspaceId={workspaceId} tabId={tab.id} />;
  if (tab.kind === "diff") return <DiffView key={tab.id} workspaceId={workspaceId} tabId={tab.id} />;
  if (tab.kind === "plan") return <PlanView key={tab.id} workspaceId={workspaceId} tabId={tab.id} />;
  if (tab.kind === "json") return <JsonTabView key={tab.id} workspaceId={workspaceId} tabId={tab.id} />;
  return <QueryView key={tab.id} workspaceId={workspaceId} tabId={tab.id} />;
}
