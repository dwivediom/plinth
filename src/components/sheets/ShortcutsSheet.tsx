import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { actions, type Action } from "../../app/actions";
import { Sheet } from "../../components/common/Overlays";
import { chordLabel } from "../../lib/keys";
import { useUi } from "../../state/ui";

const extra: { label: string; chord: string; group: Action["group"] }[] = [
  { label: "Edit cell", chord: "Enter", group: "Data" },
  { label: "Cancel edit / clear", chord: "Escape", group: "Data" },
  { label: "Copy cell (or row as TSV)", chord: "Mod+C", group: "Data" },
  { label: "Delete row", chord: "Mod+Backspace", group: "Data" },
  { label: "Open in new tab (sidebar)", chord: "Mod+Enter", group: "Navigate" },
  { label: "Open in Structure (sidebar)", chord: "Alt+Enter", group: "Navigate" },
  { label: "New workspace from switcher", chord: "Enter", group: "Navigate" },
  { label: "Replace current workspace", chord: "Alt+Enter", group: "Navigate" },
];

export function ShortcutsSheet() {
  const close = useUi((s) => s.closeOverlay);
  const [q, setQ] = useState("");
  const groups = useMemo(() => {
    const all = [...actions.filter((a) => a.chord).map((a) => ({ label: a.label, chord: a.chord!, group: a.group })), ...extra];
    const filtered = q ? all.filter((a) => a.label.toLowerCase().includes(q.toLowerCase()) || chordLabel(a.chord).toLowerCase().includes(q.toLowerCase())) : all;
    const order: Action["group"][] = ["Tabs", "Navigate", "View", "Query", "Data", "App"];
    return order.map((g) => ({ g, items: filtered.filter((a) => a.group === g) })).filter((x) => x.items.length);
  }, [q]);

  return (
    <Sheet onClose={close} width={640}>
      <h2>Keyboard Shortcuts</h2>
      <div className="field">
        <span className="glyph">
          <Search />
        </span>
        <input placeholder="Search shortcuts" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      </div>
      <div className="shortcuts" style={{ maxHeight: "60vh", overflow: "auto" }}>
        {groups.map(({ g, items }) => (
          <div key={g}>
            <h3>{g}</h3>
            {items.map((a, i) => (
              <div className="k" key={i}>
                <span>{a.label}</span>
                <span className="kbd">{chordLabel(a.chord)}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="actions">
        <button className="btn default" onClick={close}>
          Done
        </button>
      </div>
    </Sheet>
  );
}
