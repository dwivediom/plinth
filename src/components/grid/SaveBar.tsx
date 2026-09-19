import { useRef, useState } from "react";
import { Copy, Eye } from "lucide-react";
import { errorMessage, invoke } from "../../ipc/client";
import type { ChangePreview, ChangeSet } from "../../ipc/types";
import { chordLabel } from "../../lib/keys";
import { toast } from "../../state/overlays";
import { usePopoverDismiss } from "../../components/common/Overlays";

interface Props {
  workspaceId: string;
  count: number;
  changes: () => ChangeSet;
  saving: boolean;
  error: string | null;
  onRevert: () => void;
  onSave: () => void;
}

export function SaveBar({ workspaceId, count, changes, saving, error, onRevert, onSave }: Props) {
  const [preview, setPreview] = useState<ChangePreview | { error: string } | null>(null);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  usePopoverDismiss(open, () => setOpen(false), ref);

  const showPreview = async () => {
    setOpen(true);
    setPreview(null);
    try {
      setPreview(await invoke("changes_preview", { workspaceId, changes: changes() }));
    } catch (e) {
      setPreview({ error: errorMessage(e) });
    }
  };

  return (
    <div className="savebar" role="region" aria-label="Unsaved changes">
      <span>
        {count} unsaved change{count === 1 ? "" : "s"}
      </span>
      {error && <span className="err truncate">{error}</span>}
      <div className="btns">
        <button className="btn" onClick={() => void showPreview()} aria-expanded={open}>
          <Eye style={{ width: 12, height: 12 }} /> Preview SQL
        </button>
        <button className="btn" onClick={onRevert} disabled={saving}>
          Revert
        </button>
        <button className="btn default" onClick={onSave} disabled={saving}>
          {saving ? "Saving…" : `Save ${chordLabel("Mod+S")}`}
        </button>
      </div>
      {open && (
        <div ref={ref} className="popover preview-pop" role="dialog" aria-label="SQL preview">
          <div className="h">
            <span>{preview && "statements" in preview ? `${preview.statements.length} statement${preview.statements.length === 1 ? "" : "s"} · ~${preview.affectedEstimate} row${preview.affectedEstimate === 1 ? "" : "s"}` : preview ? "Preview failed" : "Generating…"}</span>
            {preview && "statements" in preview && (
              <button className="btn mini" onClick={() => void navigator.clipboard.writeText(preview.statements.join("\n")).then(() => toast("Copied SQL"))}>
                <Copy style={{ width: 11, height: 11 }} /> Copy
              </button>
            )}
          </div>
          <pre>{preview ? ("statements" in preview ? preview.statements.join("\n") : preview.error) : ""}</pre>
        </div>
      )}
    </div>
  );
}
