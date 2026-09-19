import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, Check, CornerDownLeft, Minus, Search, Sparkles, X } from "lucide-react";
import { chordLabel, isMac } from "../../lib/keys";
import { isTauri } from "../../ipc/client";
import { useUi } from "../../state/ui";
import { COMPARE, COMPARE_COLUMNS, FEATURES, NOT_YET, TASKS, type Cell, type Task } from "./content";
import { SHOTS } from "./Shots";

declare const __APP_VERSION__: string;

/** `code` in the copy comes out as code. Prose stays prose. */
function rich(text: string) {
  return text.split(/`([^`]+)`/g).map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part));
}

/**
 * The guide: what this app does, how to work it, and how it differs.
 *
 * It is one long page rather than a help menu because the questions people
 * actually have are "what is in here" and "how do I do X" — and the second
 * one is a search box, not a table of contents. Anything the app can simply
 * do for you has a button that does it.
 */
export function Guide() {
  const close = useUi((s) => s.closeOverlay);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  const results = useMemo(() => searchTasks(q), [q]);
  const searching = q.trim().length > 0;

  useEffect(() => {
    setSel(0);
    // The tour and the results share one scroller: without this, a search
    // made halfway down the page lands you below its own answers.
    if (scroller.current) scroller.current.scrollTop = 0;
  }, [q]);
  useEffect(() => input.current?.focus(), []);

  // Escape backs out one level at a time: the search first, then the guide.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        if (q) setQ("");
        else close();
        return;
      }
      if (!searching) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setSel((s) => Math.max(0, Math.min(results.length - 1, s + (e.key === "ArrowDown" ? 1 : -1))));
      }
      if (e.key === "Enter") {
        const t = results[sel];
        if (t?.run) {
          e.preventDefault();
          t.run();
          close();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [q, close, results, sel, searching]);

  // Sections animate the first time they are scrolled to, and then stay put.
  useEffect(() => {
    const root = scroller.current;
    if (!root) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add("in");
            io.unobserve(e.target);
          }
        }
      },
      { root, rootMargin: "0px 0px -12% 0px", threshold: 0.12 },
    );
    root.querySelectorAll("[data-reveal]").forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [searching]);

  return (
    <div className="guide" role="dialog" aria-modal="true" aria-label="Guide">
      <header className={`gtop${isMac && isTauri ? " mac" : ""}`} data-tauri-drag-region>
        <span className="mark">
          <i className="glyph" aria-hidden />
          Plinth
        </span>
        <div className="gsearch">
          <Search />
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="How do I…  connect · chart a result · stop writing to production"
            aria-label="Search the guide"
          />
          {q ? (
            <button className="clear" onClick={() => setQ("")} aria-label="Clear">
              <X />
            </button>
          ) : (
            <span className="kbd">{results.length} answers</span>
          )}
        </div>
        <button className="icon-btn" onClick={close} title={`Close (${chordLabel("Escape")})`} aria-label="Close guide">
          <X />
        </button>
      </header>

      <div className="gbody" ref={scroller}>
        {searching ? (
          <Results items={results} sel={sel} onHover={setSel} onDone={close} q={q} />
        ) : (
          <>
            <Hero onExample={(s) => setQ(s)} />
            {FEATURES.map((f, i) => {
              const Shot = SHOTS[f.id];
              const steps = TASKS.filter((t) => t.feature === f.id);
              return (
                <section className={`row${i % 2 ? " flip" : ""}`} key={f.id} data-reveal>
                  <div className="say">
                    <span className="kicker">{f.kicker}</span>
                    <h2>{f.title}</h2>
                    <p>{rich(f.body)}</p>
                    <ul className="points">
                      {f.points.map((p) => (
                        <li key={p}>
                          <Check />
                          <span>{rich(p)}</span>
                        </li>
                      ))}
                    </ul>
                    {!!steps.length && (
                      <div className="howto">
                        <span className="lbl">How to work it</span>
                        {steps.map((t) => (
                          <button key={t.id} className="jump" onClick={() => setQ(t.q)}>
                            <span>{t.q}</span>
                            {t.chord ? <span className="kbd">{chordLabel(t.chord)}</span> : <ArrowRightTiny />}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <figure className="show">{Shot ? <Shot /> : null}</figure>
                </section>
              );
            })}

            <Compare />

            <section className="honest" data-reveal>
              <h2>What it does not do yet</h2>
              <p className="lede">A tour that only lists wins is an advertisement. These are the edges, today.</p>
              <ul>
                {NOT_YET.map((n) => (
                  <li key={n}>
                    <Minus />
                    <span>{rich(n)}</span>
                  </li>
                ))}
              </ul>
            </section>

            <footer className="gfoot">
              <span>Plinth {__APP_VERSION__} · open source</span>
              <span className="sp" />
              <span>
                Press <b className="kbd">{chordLabel("Mod+/")}</b> for shortcuts · <b className="kbd">{chordLabel("Mod+P")}</b> to go anywhere
              </span>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}

function ArrowRightTiny() {
  return <span className="tinyarrow" aria-hidden>→</span>;
}

// ───────────────────────────── the hero ─────────────────────────────

const EXAMPLES = ["set up the AI", "why is my query slow", "compare staging and production", "read a vector column"];

function Hero({ onExample }: { onExample: (s: string) => void }) {
  return (
    <section className="hero in">
      <div className="halo" aria-hidden />
      <span className="kicker">
        <Sparkles /> The guide
      </span>
      <h1>
        A database client that <em>explains itself</em>.
      </h1>
      <p className="lede">
        Everything below is in the app you already have — no account, no upload, no tier. The model runs on your machine, the query plan is read on your machine, and the
        things that can destroy data make you look at them first.
      </p>
      <div className="tries">
        <span className="lbl">Try asking</span>
        {EXAMPLES.map((e) => (
          <button key={e} className="try" onClick={() => onExample(e)}>
            {e}
          </button>
        ))}
      </div>
      <div className="scroll-hint" aria-hidden>
        <ArrowDown />
      </div>
    </section>
  );
}

// ──────────────────────────── the search ────────────────────────────

function searchTasks(q: string): Task[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return TASKS;
  const words = needle.split(/\s+/);
  const scored = TASKS.map((t) => {
    const title = t.q.toLowerCase();
    const hay = `${title} ${t.also ?? ""} ${t.steps.join(" ")}`.toLowerCase();
    let score = 0;
    for (const w of words) {
      if (title.includes(w)) score += 3;
      else if (hay.includes(w)) score += 1;
      else return { t, score: -1 };
    }
    if (title.startsWith(words[0])) score += 2;
    return { t, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.t);
}

function Results({ items, sel, onHover, onDone, q }: { items: Task[]; sel: number; onHover: (i: number) => void; onDone: () => void; q: string }) {
  if (!items.length) {
    return (
      <div className="noresult">
        <p>Nothing here answers “{q}”.</p>
        <p className="lede">
          The guide covers what the app does. For anything else, the console (<b className="kbd">{chordLabel("Mod+Shift+C")}</b>) shows exactly what ran, and the
          shortcut sheet (<b className="kbd">{chordLabel("Mod+/")}</b>) lists every key.
        </p>
      </div>
    );
  }
  return (
    <div className="results">
      {items.map((t, i) => (
        <article key={t.id} className={`answer${i === sel ? " on" : ""}`} onMouseEnter={() => onHover(i)}>
          <header>
            <h3>{t.q}</h3>
            {t.chord && <span className="kbd">{chordLabel(t.chord)}</span>}
            {t.run && (
              <button
                className="btn default"
                onClick={() => {
                  t.run?.();
                  onDone();
                }}
              >
                Do it {i === sel && <CornerDownLeft />}
              </button>
            )}
          </header>
          <ol>
            {t.steps.map((s, n) => (
              <li key={n}>
                <span className="n">{n + 1}</span>
                <span>{rich(s)}</span>
              </li>
            ))}
          </ol>
        </article>
      ))}
    </div>
  );
}

// ─────────────────────────── the comparison ──────────────────────────

const MARK: Record<Cell["v"], string> = { yes: "●", part: "◐", no: "○", paid: "◒" };

function Compare() {
  return (
    <section className="versus" data-reveal>
      <h2>How it differs</h2>
      <p className="lede">
        The row is the capability; the note under each mark is what that product actually offers. Checked against each product's own documentation and pricing. If
        something here has gone stale, it is a bug — tell us.
      </p>
      <div className="table" role="table">
        <div className="hrow" role="row">
          <span role="columnheader" />
          {COMPARE_COLUMNS.map((c, i) => (
            <span key={c} role="columnheader" className={i === 0 ? "us" : undefined}>
              {c}
            </span>
          ))}
        </div>
        {COMPARE.map((r) => (
          <div className="crow" role="row" key={r.label}>
            <span role="rowheader">{r.label}</span>
            {r.cells.map((c, i) => (
              <span role="cell" key={i} className={`cell ${c.v}${i === 0 ? " us" : ""}`}>
                <b aria-hidden>{MARK[c.v]}</b>
                <span className="vt">{c.t}</span>
              </span>
            ))}
          </div>
        ))}
      </div>
      <p className="key">
        <b>●</b> yes <b>◐</b> partly <b>◒</b> paid tier <b>○</b> no
      </p>
    </section>
  );
}
