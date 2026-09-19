import { useEffect } from "react";
import { X } from "lucide-react";
import { JsonViewer } from "./JsonViewer";
import { useUi } from "../../state/ui";

/**
 * One document, enlarged.
 *
 * The side panel is the right size for a glance and the wrong size for
 * reading; a tab is the right size for reading and loses the row you were
 * looking at. This is the middle: the full viewer over the app, with the
 * table still behind it, and Escape to put it back.
 */
export function JsonZoom({ text, title, sqlColumn }: { text: string; title: string; sqlColumn: string | null }) {
  const close = useUi((s) => s.closeOverlay);

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

  return (
    <>
      <div className="scrim" onMouseDown={close} />
      <div className="jzoom" role="dialog" aria-modal="true" aria-label={`${title} — JSON`}>
        <JsonViewer
          text={text}
          title={title}
          sqlColumn={sqlColumn}
          actions={
            <button className="icon-btn small" title="Close (Escape)" onClick={close}>
              <X />
            </button>
          }
        />
      </div>
    </>
  );
}
