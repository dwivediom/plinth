import { useEffect, useState } from "react";
import { Braces, ClipboardPaste, Code, Minimize2, Pilcrow, X } from "lucide-react";
import { JsonViewer } from "./JsonViewer";
import { parseTolerant } from "../../lib/json/tolerant";
import { valueAt } from "../../lib/json/model";
import { toast } from "../../state/overlays";
import { useUi } from "../../state/ui";

/**
 * The JSON viewer with no database behind it.
 *
 * Reachable from the launcher, so the app is usable as a JSON tool before any
 * connection exists — which is the state people are in when someone sends
 * them a payload and asks what is wrong with it.
 */
export function JsonScratch() {
  const close = useUi((s) => s.closeOverlay);
  const [text, setText] = useState("");
  const [editing, setEditing] = useState(true);
  const parsed = parseTolerant(text);
  // Anything with text in it can be viewed. That is the point: the document
  // you need to look at is the one that will not parse.
  const ready = !!text.trim();
  const errors = parsed.issues.filter((i) => i.kind === "error").length;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [close]);

  /** Format writes back what the parser understood, so on a broken document
   *  it is also a repair — the output is valid JSON. */
  const reformat = (indent: number) => {
    if (!ready) return;
    setText(JSON.stringify(valueAt(parsed.doc, 0), null, indent));
    if (parsed.issues.length) toast("Rewritten as valid JSON from what could be read.");
  };

  return (
    <div className="jscratch" role="dialog" aria-modal="true" aria-label="JSON viewer">
      <div className="jbar">
        <span className="jtitle">
          <Braces /> JSON viewer
        </span>
        <span className={`jstat${errors ? " bad" : ""}`}>
          {!text.trim()
            ? "Paste a document"
            : `${parsed.doc.nodes.length.toLocaleString()} nodes${errors ? ` · ${errors} problem${errors === 1 ? "" : "s"}` : parsed.issues.length ? ` · ${parsed.issues.length} not valid JSON` : ""}`}
        </span>
        <span className="spacer" />
        {editing ? (
          <>
            <button
              className="btn mini"
              onClick={() =>
                void navigator.clipboard.readText().then(
                  (t) => setText(t),
                  () => toast("Could not read the clipboard — paste into the box instead.", "error"),
                )
              }
            >
              <ClipboardPaste /> Paste
            </button>
            <button className="btn mini" disabled={!ready} onClick={() => reformat(2)}>
              <Pilcrow /> {parsed.issues.length ? "Repair" : "Format"}
            </button>
            <button className="btn mini" disabled={!ready} onClick={() => reformat(0)}>
              <Minimize2 /> Minify
            </button>
            <button className="btn default mini" disabled={!ready} onClick={() => setEditing(false)}>
              View
            </button>
          </>
        ) : (
          <button className="btn mini" onClick={() => setEditing(true)}>
            <Code /> Edit
          </button>
        )}
        <button className="icon-btn" onClick={close} aria-label="Close">
          <X />
        </button>
      </div>
      {editing ? (
        <textarea className="jtext selectable" autoFocus spellCheck={false} placeholder="Paste JSON here" value={text} onChange={(e) => setText(e.target.value)} />
      ) : (
        <JsonViewer text={text} title="Pasted" />
      )}
    </div>
  );
}
