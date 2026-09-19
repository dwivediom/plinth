import { useEffect, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { useWriteGate } from "../../state/overlays";

/**
 * The last thing between a destructive statement and the database.
 *
 * It shows the statement — the actual text that will be sent, not a summary
 * of it — and for the serious tier it asks for the table's name to be typed.
 * The go-ahead button stays disabled until it matches, and Escape is always
 * the way out.
 */
export function WriteGate() {
  const current = useWriteGate((s) => s.current);
  const answer = useWriteGate((s) => s.answer);
  const [typed, setTyped] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setTyped("");
    if (!current) return;
    const t = setTimeout(() => (current.confirmWord ? input.current?.focus() : cancelRef.current?.focus()), 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        answer(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      clearTimeout(t);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [current, answer]);

  if (!current) return null;
  const need = current.confirmWord;
  const matched = !need || typed.trim().toLowerCase() === need.toLowerCase();

  return (
    <>
      <div className="scrim over" onMouseDown={() => answer(false)} />
      <div className={`wgate ${current.severity}`} role="alertdialog" aria-modal="true" aria-label={current.title}>
        <div className="head">
          <span className="ring" aria-hidden>
            <AlertTriangle />
          </span>
          <div>
            <h2>{current.title}</h2>
            <p>{current.detail}</p>
          </div>
        </div>

        <div className="sql selectable">
          {current.statements.map((s, i) => (
            <code key={i}>{s.trim().replace(/;?\s*$/, ";")}</code>
          ))}
        </div>

        {need && (
          <form
            className="typeit"
            onSubmit={(e) => {
              e.preventDefault();
              if (matched) answer(true);
            }}
          >
            <label htmlFor="wgate-confirm">
              Type <b>{need}</b> to confirm
            </label>
            <div className="field mono">
              <input
                id="wgate-confirm"
                ref={input}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={!!typed && !matched}
              />
            </div>
          </form>
        )}

        <div className="actions">
          <span className="left">{need ? "This one cannot be undone by closing the tab." : "The statement above is exactly what will be sent."}</span>
          <button className="btn" ref={cancelRef} onClick={() => answer(false)}>
            Cancel
          </button>
          <button className="btn danger solid" disabled={!matched} onClick={() => answer(true)}>
            {current.verb}
          </button>
        </div>
      </div>
    </>
  );
}
