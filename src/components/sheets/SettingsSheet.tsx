import { AiSetup } from "../inspector/AiSetup";
import { Sheet } from "../../components/common/Overlays";
import { useUi, type Theme } from "../../state/ui";

export function SettingsSheet() {
  const close = useUi((s) => s.closeOverlay);
  const theme = useUi((s) => s.theme);
  const setTheme = useUi((s) => s.setTheme);
  const defaultLimit = useUi((s) => s.defaultLimit);
  const setPref = useUi((s) => s.setPref);

  return (
    <Sheet onClose={close} width={460} className="settings">
      <h2>Settings</h2>
      <div className="form">
        <label htmlFor="s-theme">Appearance</label>
        <select id="s-theme" className="native" style={{ width: 160 }} value={theme} onChange={(e) => setTheme(e.target.value as Theme)}>
          <option value="system">Match System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>

        <label htmlFor="s-limit">Default limit</label>
        <select id="s-limit" className="native" style={{ width: 160 }} value={defaultLimit ?? "none"} onChange={(e) => setPref("defaultLimit", e.target.value === "none" ? null : Number(e.target.value))}>
          <option value="none">No limit</option>
          <option value="100">100 rows</option>
          <option value="1000">1 000 rows</option>
          <option value="10000">10 000 rows</option>
        </select>

        <label>AI / MCP</label>
        <div className="note">
          Answers come from a local Ollama model or from an MCP client that queries Plinth through the same policy engine and audit log. The same controls sit in the inspector's AI tab.
          <AiSetup />
          <details style={{ marginTop: 8 }}>
            <summary>Configure a client by hand</summary>
            <pre className="mono" style={{ margin: "8px 0 0", font: "var(--t-mono)", fontSize: 11, background: "var(--alt-row)", padding: 8, borderRadius: "var(--r-control)", userSelect: "text", WebkitUserSelect: "text" }}>{`{ "mcpServers": { "plinth": { "command": "/path/to/plinth-mcp" } } }`}</pre>
          </details>
        </div>
      </div>
      <div className="actions">
        <button className="btn default" onClick={close}>
          Done
        </button>
      </div>
    </Sheet>
  );
}
