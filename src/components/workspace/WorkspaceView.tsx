import { useEffect } from "react";
import { Sidebar } from "../../components/sidebar/Sidebar";
import { TabBar } from "../../components/tabs/TabBar";
import { TabContent } from "../../components/tabs/TabContent";
import { Inspector } from "../../components/inspector/Inspector";
import { ConsolePanel } from "../../components/console/ConsolePanel";
import { useSaved } from "../../state/saved";
import { useUi } from "../../state/ui";
import { useWorkspaces } from "../../state/workspaces";
import { Toolbar } from "./Toolbar";
import { WorkspaceBar } from "./WorkspaceBar";
import { ReconnectStrip } from "./ReconnectStrip";
import { StatusBar } from "./StatusBar";

export function WorkspaceView({ workspaceId }: { workspaceId: string }) {
  const w = useWorkspaces((s) => s.byId[workspaceId]);
  const sidebarVisible = useUi((s) => s.sidebarVisible);
  const sidebarWidth = useUi((s) => s.sidebarWidth);
  const inspectorVisible = useUi((s) => s.inspectorVisible);
  const consoleVisible = useUi((s) => s.consoleVisible);

  useEffect(() => {
    if (!useSaved.getState().loaded) void useSaved.getState().load();
  }, []);

  if (!w) return null;
  const cls = `doc${sidebarVisible ? "" : " no-sidebar"}${inspectorVisible ? " with-inspector" : ""}`;
  return (
    <div className={cls} style={{ ["--sidebar-w" as string]: `${sidebarWidth}px` }}>
      {sidebarVisible && <Sidebar workspaceId={workspaceId} />}
      <div className="main">
        <Toolbar workspaceId={workspaceId} />
        <WorkspaceBar />
        <TabBar workspaceId={workspaceId} />
        {(w.connState === "down" || w.connState === "degraded") && <ReconnectStrip workspaceId={workspaceId} />}
        <div className={`content${w.connState === "down" ? " dim" : ""}`}>
          <TabContent workspaceId={workspaceId} />
        </div>
        {consoleVisible && <ConsolePanel workspaceId={workspaceId} />}
        <StatusBar workspaceId={workspaceId} />
      </div>
      {inspectorVisible && <Inspector workspaceId={workspaceId} />}
    </div>
  );
}
