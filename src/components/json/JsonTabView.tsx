import { useCallback, useState } from "react";
import { Braces, ClipboardPaste, Code, Maximize2, Minimize2, Pilcrow, Save, X } from "lucide-react";
import { JsonViewer } from "./JsonViewer";
import { parseTolerant } from "../../lib/json/tolerant";
import { valueAt } from "../../lib/json/model";
import { toast } from "../../state/overlays";
import type { JsonTab } from "../../state/types";
import { useWorkspaces } from "../../state/workspaces";

/**
 * A JSON document as a tab: browse it, or edit the raw text.
 *
 * The two modes are deliberately separate rather than one editable tree. A
 * tree that is also an editor has to decide what a half-typed value means on
 * every keystroke; a text pane does not, and the tree re-reads the text the
 * moment it parses. Round-tripping through text is also what people actually
 * do — paste something in, fix it, look at it.
 */
export function JsonTabView({ workspaceId, tabId }: { workspaceId: string; tabId: string }) {
  const tab = useWorkspaces((s) => s.byId[workspaceId]?.tabs.find((t) => t.id === tabId)) as JsonTab | undefined;
  const updateTab = useWorkspaces((s) => s.updateTab);
  const [draft, setDraft] = useState<string | null>(null);

  const setText = useCallback((text: string) => updateTab<JsonTab>(workspaceId, tabId, { text }), [updateTab, workspaceId, tabId]);
  if (!tab) return null;

  const editing = tab.editing;
  const text = draft ?? tab.text;
  const parsed = parseTolerant(text);
  const errors = parsed.issues.filter((i) => i.kind === "error").length;

  const commit = () => {
    setText(text);
    setDraft(null);
    updateTab<JsonTab>(workspaceId, tabId, { editing: false });
  };

  /** Also a repair: what comes back is valid JSON, built from what parsed. */
  const reformat = (indent: number) => {
    if (!text.trim()) return;
    setDraft(JSON.stringify(valueAt(parsed.doc, 0), null, indent));
    if (parsed.issues.length) toast("Rewritten as valid JSON from what could be read.");
  };

  const paste = async () => {
    try {
      const clip = await navigator.clipboard.readText();
      if (!clip.trim()) return toast("The clipboard is empty.", "error");
      setDraft(clip);
      updateTab<JsonTab>(workspaceId, tabId, { editing: true });
    } catch {
      toast("Could not read the clipboard — paste into the text area instead.", "error");
    }
  };

  if (editing) {
    return (
      <div className="jsontab">
        <div className="jbar">
          <span className="jtitle">{tab.origin ? `JSON · ${tab.origin}` : "JSON"}</span>
          <span className={`jstat${errors ? " bad" : ""}`}>
            {`${parsed.doc.nodes.length.toLocaleString()} nodes`}
            {errors ? ` · ${errors} problem${errors === 1 ? "" : "s"}` : parsed.issues.length ? ` · ${parsed.issues.length} not valid JSON` : ""}
          </span>
          <span className="spacer" />
          <button className="btn mini" onClick={() => void paste()} title="Replace with the clipboard">
            <ClipboardPaste /> Paste
          </button>
          <button className="btn mini" onClick={() => reformat(2)} title="Pretty-print — and repair, when the document does not parse">
            <Pilcrow /> {parsed.issues.length ? "Repair" : "Format"}
          </button>
          <button className="btn mini" onClick={() => reformat(0)} title="Strip all whitespace">
            <Minimize2 /> Minify
          </button>
          <button className="btn default mini" onClick={commit} title="Back to the tree">
            <Save /> Done
          </button>
        </div>
        <textarea
          className="jtext selectable"
          value={text}
          spellCheck={false}
          autoFocus
          placeholder="Paste JSON here"
          onChange={(e) => setDraft(e.target.value)}
        />
      </div>
    );
  }

  return (
    <div className="jsontab">
      <JsonViewer
        text={tab.text}
        title={tab.origin ?? "JSON"}
        sqlColumn={tab.sqlColumn}
        actions={
          <button className="icon-btn small" title="Edit the raw text" onClick={() => updateTab<JsonTab>(workspaceId, tabId, { editing: true })}>
            <Code />
          </button>
        }
      />
    </div>
  );
}

/**
 * The same document beside the grid, so the row stays visible.
 *
 * The inspector is narrow, so this is the dense variant with the search bar
 * kept — searching is the reason to open it on a big document at all.
 */
export function JsonSide({
  text,
  title,
  sqlColumn,
  onOpenTab,
  onEnlarge,
  onClose,
}: {
  text: string;
  title: string;
  sqlColumn?: string | null;
  onOpenTab?: () => void;
  onEnlarge?: () => void;
  onClose?: () => void;
}) {
  return (
    <JsonViewer
      dense
      // The panel is as tall as the document, up to a point: two keys should
      // not be a box with one line in it.
      maxRows={14}
      text={text}
      title={title}
      sqlColumn={sqlColumn}
      actions={
        <>
          {onEnlarge && (
            <button className="icon-btn small" title="Enlarge — read it without leaving the row" onClick={onEnlarge}>
              <Maximize2 />
            </button>
          )}
          {onOpenTab && (
            <button className="icon-btn small" title="Open in its own tab" onClick={onOpenTab}>
              <Braces />
            </button>
          )}
          {onClose && (
            <button className="icon-btn small" title="Close" onClick={onClose}>
              <X />
            </button>
          )}
        </>
      }
    />
  );
}
