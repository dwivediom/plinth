import { useEffect, useId } from "react";
import { Check, Cpu, Download, Play, Plug, RefreshCw } from "lucide-react";
import { invoke } from "../../ipc/client";
import { parseEngine, useAi } from "../../state/ai";

function ollamaLabel(running: boolean, installed: boolean, version: string | null) {
  if (running) return { tone: "g", text: `Running${version ? ` · v${version}` : ""}` };
  if (installed) return { tone: "o", text: "Installed, not running" };
  return { tone: "r", text: "Not installed" };
}

/**
 * Local-AI setup: what this machine can run, one dropdown that picks who
 * answers — a local Ollama model or an MCP client — and the button that
 * makes that choice real. Rendered in the inspector's AI tab and in Settings.
 */
export function AiSetup() {
  const status = useAi((s) => s.status);
  const engine = useAi((s) => s.engine);
  const busy = useAi((s) => s.busy);
  const note = useAi((s) => s.note);
  const setEngine = useAi((s) => s.setEngine);
  const probe = useAi((s) => s.probe);
  const run = useAi((s) => s.run);
  // The pane and the settings sheet can both be mounted — ids must not clash.
  const selectId = useId();

  useEffect(() => {
    if (!status) void probe();
  }, [status, probe]);

  // A pull is gigabytes and runs in the backend — poll until it lands.
  const pulling = status?.pulling && !status.pulling.done ? status.pulling.model : null;
  useEffect(() => {
    if (!pulling) return;
    const t = setInterval(() => void probe(), 2500);
    return () => clearInterval(t);
  }, [pulling, probe]);

  if (!status) {
    return (
      <div className="setup">
        <div className="sec-h">This machine</div>
        <div className="muted">Checking this machine…</div>
      </div>
    );
  }

  const hw = status.hardware;
  const o = ollamaLabel(status.ollama.running, status.ollama.installed, status.ollama.version);
  const sel = parseEngine(engine);
  const model = sel?.kind === "ollama" ? status.models.find((m) => m.name === sel.model) ?? null : null;
  const client = sel?.kind === "mcp" ? status.mcp.clients.find((c) => c.id === sel.client) ?? null : null;

  return (
    <div className="setup">
      <div className="sec-h">
        This machine
        <button className="lnk" onClick={() => void run("probe", async () => ({ ok: true, message: "Re-checked." }))} disabled={busy != null} title="Re-check Ollama and MCP">
          <RefreshCw /> Analyze
        </button>
      </div>
      <div className="hw">
        <Cpu />
        <span>
          {hw.chip}
          {hw.cpuCores ? ` · ${hw.cpuCores} cores` : ""}
          <br />
          {hw.memoryGb ? `${hw.memoryGb} GB ${hw.unifiedMemory ? "unified" : "RAM"} · ~${hw.usableModelGb} GB for models` : "Memory unknown"}
        </span>
      </div>

      <div className="sec-h">Ollama</div>
      <div className="line">
        <span className={`dot ${o.tone}`} aria-hidden />
        <span>{o.text}</span>
      </div>
      {!status.ollama.installed && (
        <button className="btn" onClick={() => void run("install", () => invoke("ai_ollama_install", {}))} disabled={busy != null}>
          <Download /> {busy === "install" ? "Installing…" : "Install Ollama"}
        </button>
      )}
      {status.ollama.installed && !status.ollama.running && (
        <button className="btn" onClick={() => void run("start", () => invoke("ai_ollama_start", {}))} disabled={busy != null}>
          <Play /> {busy === "start" ? "Starting…" : "Start Ollama"}
        </button>
      )}

      <label className="sec-l" htmlFor={selectId}>
        Answers come from
      </label>
      <select id={selectId} className="native" value={engine} onChange={(e) => setEngine(e.target.value)} disabled={busy != null}>
        <optgroup label="Local models · Ollama">
          {status.models.map((m) => (
            <option key={m.name} value={`ollama:${m.name}`} disabled={!m.fits && !m.installed}>
              {m.label} · {m.downloadGb} GB{m.installed ? " · installed" : m.fits ? "" : ` · needs ${m.needsGb} GB`}
            </option>
          ))}
        </optgroup>
        <optgroup label="MCP clients">
          {status.mcp.clients.map((c) => (
            <option key={c.id} value={`mcp:${c.id}`}>
              {c.name}
              {c.registered ? " · connected" : c.available ? "" : " · not installed"}
            </option>
          ))}
        </optgroup>
      </select>

      {model && <div className="muted">{model.note}</div>}
      {model &&
        (pulling === model.name ? (
          <div className="muted">Pulling {pulling}… this can take a few minutes.</div>
        ) : model.installed ? (
          <div className="muted ok">
            <Check /> Pulled and ready — ask below, nothing leaves this machine.
          </div>
        ) : (
          <button
            className="btn"
            onClick={() => void run("pull", () => invoke("ai_model_pull", { model: model.name }))}
            disabled={busy != null || !status.ollama.running || pulling != null}
            title={status.ollama.running ? undefined : "Start Ollama first"}
          >
            <Download /> Pull {model.downloadGb} GB
          </button>
        ))}

      {client && (
        <>
          <div className="muted">
            {client.registered
              ? `Ask in ${client.name} — it queries Plinth over MCP, through the same policy engine and audit log.`
              : status.mcp.built
                ? `Points ${client.name} at plinth-mcp.`
                : status.mcp.buildable
                  ? "plinth-mcp isn't built yet — Connect builds it first (a few minutes)."
                  : "plinth-mcp isn't on this machine."}
          </div>
          {client.registered ? (
            <div className="muted ok">
              <Check /> Connected · restart {client.name} if it was already open.
            </div>
          ) : (
            <button className="btn" onClick={() => void run(client.id, () => invoke("ai_mcp_connect", { client: client.id }))} disabled={busy != null}>
              <Plug /> {busy === client.id ? "Connecting…" : `Connect ${client.name}`}
            </button>
          )}
        </>
      )}

      {note && <div className={`muted ${note.ok ? "ok" : "bad"}`}>{note.text}</div>}
    </div>
  );
}
