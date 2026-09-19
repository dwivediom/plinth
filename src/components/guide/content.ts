import { actions } from "../../app/actions";
import { useUi } from "../../state/ui";
import { useWorkspaces } from "../../state/workspaces";

/**
 * Everything the guide knows.
 *
 * Two kinds of content: **tasks** (the "how do I…" index behind the search
 * box, each one a short recipe and, where it can be, a button that does it)
 * and **features** (the tour). Both are plain data so the page is only
 * layout — and so a claim can be corrected in one place.
 */

export interface Task {
  id: string;
  /** How a person would ask it. */
  q: string;
  /** Extra words worth matching that the question does not contain. */
  also?: string;
  steps: string[];
  chord?: string;
  /** Section of the tour this belongs to, if any. */
  feature?: string;
  /** If the app can just do it, do it. */
  run?: () => void;
}

const active = () => {
  const s = useWorkspaces.getState();
  return s.activeId ?? null;
};
const fire = (id: string) => () => actions.find((a) => a.id === id)?.run();
const ui = () => useUi.getState();

export const TASKS: Task[] = [
  // ── getting connected ────────────────────────────────────────────────
  {
    id: "connect",
    q: "Connect to a database",
    also: "new connection postgres mysql sqlite server host",
    steps: [
      "Press + at the top of the connection list, or Create Connection at the bottom left.",
      "Pick the driver, fill in host, user and database. The password goes to the OS keychain, never to a file.",
      "Set the environment (local / staging / production) — it colours the dot everywhere afterwards.",
      "Set the policy to read-only for anything you are nervous about. It is enforced in Rust, not in the UI.",
      "Opening a connection gives it its own window. The connection list stays where it is, ready for the next one.",
    ],
    run: () => ui().setOverlay({ kind: "driver-picker" }),
  },
  {
    id: "switch-db",
    q: "Switch to another database on the same server",
    also: "change schema catalog",
    steps: ["Press ⌘K, or click the database glyph at the top of the sidebar.", "It opens in its own window. If it is already open somewhere, that window comes forward instead."],
    chord: "Mod+K",
    run: () => ui().setOverlay({ kind: "db-switcher" }),
  },
  {
    id: "find-anything",
    q: "Find a table, a saved query or a command",
    also: "search palette jump go to",
    steps: ["Press ⌘P.", "Type a few letters. Tables, views, open tabs, saved queries and every command are in the same list."],
    chord: "Mod+P",
    run: () => ui().setOverlay({ kind: "palette" }),
  },

  // ── running SQL ──────────────────────────────────────────────────────
  {
    id: "run",
    q: "Run the statement I am standing in",
    also: "execute current selection",
    steps: ["⌘↵ runs the statement under the cursor — not the whole tab.", "Select text first to run exactly that.", "⌘⇧↵ runs every statement in the tab, in order, stopping at the first error."],
    chord: "Mod+Enter",
  },
  { id: "cancel", q: "Cancel a query that is taking too long", steps: ["⌘. cancels the running statement.", "The Run button turns into Stop while anything is in flight."], chord: "Mod+." },
  {
    id: "limit",
    q: "Stop a SELECT from returning a million rows",
    also: "row limit default fetch",
    steps: ["The Limit box in the query bar caps every SELECT in that tab.", "The default for new tabs lives in Settings → Limit.", "Results stream through a cursor, so a big table scrolls instead of loading."],
    run: () => ui().setOverlay({ kind: "settings" }),
  },
  { id: "beautify", q: "Format / beautify my SQL", steps: ["⌘I reformats the statement under the cursor.", "Keywords go upper case, clauses break onto their own lines."], chord: "Mod+I" },
  {
    id: "complete",
    q: "Get completions for tables and columns",
    also: "autocomplete intellisense join",
    steps: [
      "Type — completion is on as you go, ⌃Space forces it.",
      "Tables carry their schema and row estimate; columns carry the table they belong to.",
      "After JOIN, the whole clause is offered from the foreign-key graph: `customers ON orders.customer_id = customers.id`.",
      "Alias first (`FROM orders o`) and `o.` completes that table's columns only.",
    ],
    feature: "editor",
  },

  // ── safety ───────────────────────────────────────────────────────────
  {
    id: "safe-mode",
    q: "Make sure I cannot write to production by accident",
    also: "read only guard safety lock",
    steps: [
      "Safe mode is the padlock in the toolbar — ⌘⇧L. While it is on, the engine refuses anything that writes, so the window cannot let one through by mistake.",
      "A connection can also be read-only for good: set its policy in the connection sheet and the padlock cannot be unlocked.",
      "Every statement is classified by a real SQL parser, so `WITH … DELETE` is caught too.",
    ],
    chord: "Mod+Shift+L",
    feature: "rails",
    run: fire("safe-mode"),
  },
  {
    id: "confirm",
    q: "Why am I being asked to type a table name?",
    also: "confirmation delete update without where",
    steps: [
      "Anything that changes data stops first and shows you the statement: UPDATE, DELETE, and every kind of DDL.",
      "With a WHERE clause it is a confirmation. Without one — or for DROP, ALTER, TRUNCATE, or anything Plinth could not parse — you type the table's name.",
      "It is deliberately not a Yes button: the point is to make you read the statement once.",
      "It applies to SQL the model wrote too, through the same dialog — and to Truncate and Drop from the sidebar.",
      "If the connection's policy refuses a statement outright, the error carries the way through: Unlock safe mode, Connection settings…, or Run once anyway. The elevated run is one statement, is refused on a read-only connection, and still asks you to type the table name.",
    ],
    feature: "rails",
  },
  {
    id: "audit",
    q: "See every statement that ran, including the AI's",
    also: "history log console audit who ran",
    steps: ["⌘⇧C opens the console.", "Filter by source: app, you, or the AI. Each line carries the duration, the row count and the error if there was one.", "The sidebar's History pane is the same log, per connection, searchable."],
    chord: "Mod+Shift+C",
    run: () => ui().toggleConsole(),
  },

  // ── the AI ───────────────────────────────────────────────────────────
  {
    id: "ai-setup",
    q: "Set up the AI",
    also: "ollama local model llm install download",
    steps: [
      "Open the inspector (⌘I) and choose the AI pane, or open Settings → AI.",
      "Press Detect. If Ollama is running it is found; if it is installed but stopped it is started; if it is missing you get a one-click install.",
      "Pick a model from the dropdown — it only offers models your machine has the memory for.",
      "Nothing leaves the machine: the model runs locally over HTTP to 127.0.0.1.",
    ],
    feature: "ask",
    run: () => {
      ui().setPref("inspectorVisible", true);
      ui().setInspectorPane("ai");
    },
  },
  {
    id: "ai-ask",
    q: "Ask a question about my data in English",
    steps: [
      "Open the AI pane and type the question.",
      "It answers in prose and shows the SQL it used. Press Run to run it, or Chart to plot it.",
      "It is not allowed to state a result it has not seen — if it needs a number, it runs a query to get it.",
    ],
    feature: "ask",
  },
  {
    id: "ai-steps",
    q: "Make the AI show its work instead of guessing",
    also: "agent harness auto manual verify think",
    steps: [
      "Switch the AI pane to Agent. It works in steps: a thought, one read-only action, then what it observed.",
      "Auto runs the steps itself; Manual gives you Run / Skip on each one.",
      "It verifies its own answer before it gives it, and retries once if the check fails.",
      "Its tools are read-only — inspect, sample, probe. A write still has to go through you and the confirmation gate.",
    ],
    feature: "ask",
  },
  {
    id: "ai-pin",
    q: "Make the AI's answers more accurate",
    also: "context pin tables schema",
    steps: [
      "Right-click a table in the sidebar → Add to AI Context, or @mention it in the chat. Either way it goes into the context with its columns.",
      "Open the schema map once: the join graph it builds is what the AI uses to find its way between tables.",
    ],
    feature: "map",
  },
  {
    id: "mcp",
    q: "Let Claude query my database",
    also: "mcp server claude desktop code agent register",
    steps: [
      "Settings → AI → Connect MCP. It registers a read-only server with Claude Desktop or Claude Code.",
      "Claude gets seven tools through the same engine, the same policy and the same audit log you use.",
      "Read-only is not a setting there: the server has no write path at all.",
    ],
    feature: "ask",
    run: () => ui().setOverlay({ kind: "settings" }),
  },

  // ── understanding ────────────────────────────────────────────────────
  {
    id: "map",
    q: "See how my tables are connected",
    also: "er diagram schema graph mind map relationships",
    steps: [
      "Press Map in the workspace bar.",
      "Declared foreign keys are solid; relationships inferred from naming are dashed and labelled as inferred.",
      "Click a table to isolate its neighbourhood; double-click to open it.",
    ],
    feature: "map",
    run: () => {
      const id = active();
      if (id) useWorkspaces.getState().openMap(id);
    },
  },
  {
    id: "explain",
    q: "Find out why a query is slow",
    also: "explain analyze plan index seq scan performance",
    steps: [
      "Explain in the query bar draws the estimated plan. Explain Analyze runs it and draws the real one.",
      "Each node is shaded by its share of the runtime — self time, with per-loop times already corrected.",
      "The panel lists what is worth looking at in plain English: sequential scans, spilled sorts, bad estimates, hot loops.",
      "Analyze refuses to run anything that is not read-only, so you cannot accidentally EXPLAIN ANALYZE a DELETE.",
    ],
    feature: "explain",
  },
  {
    id: "optimize",
    q: "Make a slow query faster",
    also: "optimize index advisor tuning slow performance rewrite hypopg",
    steps: [
      "Optimize, beside Explain in the query bar. It reads the plan, works out what is costing the time, and proposes fixes.",
      "Index candidates come from the plan's own predicates — equality columns first, then ranges — and are checked against the schema.",
      "Each candidate is put back through the planner and scored. With the hypopg extension installed, an index is tested without being built; without it, candidates are shown as suggestions and labelled not measured.",
      "A rewrite from the local model is measured the same way, and is not shown at all if the server refuses to parse it.",
      "Nothing is applied for you. Create it goes through the same confirmation as any other DDL.",
    ],
    feature: "explain",
  },
  {
    id: "diff",
    q: "Check whether staging and production match",
    also: "schema diff compare migration drift ddl",
    chord: "Mod+Shift+D",
    steps: [
      "Open both databases, then press the compare glyph at the top of the sidebar — or ⌘⇧D.",
      "Pick the two sides. Tables, columns, types, nullability, defaults, indexes and foreign keys are compared.",
      "Generate migration SQL writes the statements that would make the left match the right — destructive ones commented out, for you to uncomment on purpose.",
    ],
    feature: "diff",
    run: () => {
      const id = active();
      if (id) useWorkspaces.getState().openDiff(id);
    },
  },

  // ── data ─────────────────────────────────────────────────────────────
  {
    id: "edit",
    q: "Edit a row and save it",
    also: "update cell insert delete grid",
    steps: [
      "↵ edits the cell under the cursor; ⌘N adds a row; ⌘⌫ marks one for deletion.",
      "Changes are staged — the bar at the bottom counts them and shows the SQL before anything is sent.",
      "⌘S commits, in one transaction. Safe mode blocks the commit, not the editing.",
    ],
    chord: "Mod+S",
  },
  {
    id: "chart",
    q: "Turn a result into a chart",
    also: "graph bar line donut plot visualise",
    steps: [
      "Press Chart in the results bar, or ask the AI for one.",
      "Bar, line, area, scatter, donut. X and Y are chosen for you from the shape of the result and can be changed.",
      "Transparent PNG exports at 2× with no background — it drops onto a slide or a dark README cleanly.",
    ],
    feature: "chart",
  },
  {
    id: "vector",
    q: "Read a pgvector / embedding column",
    also: "vector halfvec embeddings similarity nearest neighbour ann",
    steps: [
      "vector, halfvec and sparsevec are decoded from the binary wire format and shown as a fingerprint: a sparkline, the dimension count and the norm.",
      "Right-click a row → Find similar rows by <column>. It writes the nearest-neighbour query for you.",
      "The query anchors to the source row by key instead of pasting 1,536 numbers, so it stays readable — and the other two metrics are one edit away.",
    ],
    feature: "vector",
  },
  {
    id: "json",
    q: "Look inside a JSON column",
    also: "json viewer editor tree search keys values path large file paste",
    steps: [
      "Hover a JSON cell and press the `{}` glyph — the document opens in its own tab, with the grid still where you left it.",
      "Select the cell instead and the inspector shows the same viewer beside the table, sized to the document — and ⤢ enlarges it over the app when you want to read rather than glance.",
      "Search is scoped: keys only, values only, or both — with match case, regular expressions, and a filter that shows only matches and the path down to them.",
      "Click any node for its JSONPath, its SQL accessor (`meta -> 'address' ->> 'city'`), or its value, copyable.",
      "⌘⇧J opens an empty one to paste into, and the launcher has a JSON Viewer for when there is no database open at all.",
      "It is built on a flat index rather than a component tree, so a 4 MB document with 200,000 nodes opens and searches without pausing.",
    ],
  },

  // ── the app ──────────────────────────────────────────────────────────
  { id: "shortcuts", q: "See every keyboard shortcut", steps: ["⌘/ opens the cheat sheet."], chord: "Mod+/", run: fire("shortcuts") },
  { id: "theme", q: "Switch between light and dark", steps: ["Settings → Appearance. System follows macOS."], run: () => ui().setOverlay({ kind: "settings" }) },
  {
    id: "windows",
    q: "Work in more than one window",
    also: "second window multiple windows side by side compare two databases",
    steps: [
      "The connection list is the manager: it stays put, and each connection you open from it gets its own window.",
      "⌘⌥N opens an empty window, or File → New Window. Each window has its own connection and its own tabs.",
      "Every connection you open gets a window: from the launcher, from the connection switcher (⌘⇧K), from ⌘P. There is no second rule to remember.",
      "A connection already open in another window brings that window forward rather than opening it twice — two windows on one database would overwrite each other's tabs.",
      "⌘W closes a tab, ⇧⌘W closes the window. Closing a window disconnects what it held; the other windows are untouched.",
      "On macOS the windows can be merged into native tabs from Window → Merge All Windows.",
    ],
    chord: "Mod+Alt+N",
  },
  { id: "tabs", q: "Work in more than a couple of tabs", steps: ["⌘T opens one, ⌘1…⌘8 jump, ⌘9 goes to the last.", "Tabs are unlimited, in every build, for ever."], chord: "Mod+T" },
  {
    id: "saved",
    q: "Save a query and find it again",
    steps: ["⌘S in a query tab saves it under the connection.", "The sidebar's Queries pane lists them by folder; ⌘P finds them by name."],
  },
];

// ─────────────────────────── the tour ───────────────────────────

export interface Feature {
  id: string;
  kicker: string;
  title: string;
  body: string;
  /** Three at most: the page is a tour, not a manual. */
  points: string[];
}

export const FEATURES: Feature[] = [
  {
    id: "ask",
    kicker: "Local AI",
    title: "Ask in plain English. Watch it think.",
    body:
      "The model runs on your machine through Ollama — your schema and your rows never leave it. It answers in prose, and it is not allowed to state a number it has not actually seen.",
    points: [
      "A step at a time: a thought, one read-only action, then what it observed — Auto runs them, Manual gives you Run and Skip on each.",
      "It checks its own answer before handing it over, and retries once if the check fails.",
      "The same engine is exposed to Claude as an MCP server — read-only, through your policy, in your audit log.",
    ],
  },
  {
    id: "rails",
    kicker: "Production rails",
    title: "Nothing destructive happens by accident.",
    body:
      "Every statement is classified by a real SQL parser before it is sent, so the guard understands `WITH … DELETE` as well as it understands `DROP`.",
    points: [
      "Every UPDATE, DELETE and DDL statement shows you itself before it is sent — the exact text, whoever wrote it, typed or proposed by the model.",
      "Without a WHERE, or for a DROP or ALTER, it asks you to type the table's name. Not a Yes button — the point is that you read it.",
      "Safe mode (⌘⇧L) is refused by the engine, not by the window; a read-only connection cannot be unlocked at all.",
    ],
  },
  {
    id: "explain",
    kicker: "Visual EXPLAIN",
    title: "Why it is slow, answered on this machine.",
    body:
      "Every other client prints the plan as a wall of text, so people paste it into a website — and a plan carries your table names, your index names and your row counts. There is no reason for that: the plan is JSON and the rules are arithmetic.",
    points: [
      "Nodes are shaded by self time, with per-loop times corrected — the nested loop that ran 50,000 times shows its real cost.",
      "Seven rules in plain English: sequential scan, spilled sort, spilled hash, bad estimate, hot loop, discarded rows, dominant node.",
      "Explain Analyze refuses anything that is not read-only, so it cannot execute a DELETE on your behalf.",
      "Optimize, next to it, proposes indexes from the plan and scores each one against the planner before showing it.",
    ],
  },
  {
    id: "map",
    kicker: "Schema map",
    title: "The shape of the database, in one picture.",
    body:
      "Tables laid out by their foreign keys, so you can see the joins instead of reconstructing them from memory. Relationships that are only implied by naming are drawn dashed and labelled as inferred — never presented as fact.",
    points: [
      "The same graph powers JOIN completion in the editor and gives the AI its join paths.",
      "Click to isolate a table's neighbourhood; double-click to open it.",
      "Built from the introspection you already loaded — no extra round trip.",
    ],
  },
  {
    id: "diff",
    kicker: "Schema diff",
    title: "“Did that migration run on staging?”",
    body:
      "Point it at two open databases and it tells you, precisely: tables, columns, types, nullability, defaults, indexes, foreign keys. Column order is not a difference. `int4` and `integer` are not a difference.",
    points: [
      "Generate migration SQL writes the statements that make the left side match the right.",
      "Destructive statements come out commented — you uncomment them on purpose or not at all.",
      "A view is never emitted as a CREATE TABLE; the generator knows what kind of thing it is looking at.",
    ],
  },
  {
    id: "chart",
    kicker: "Charts",
    title: "A chart you can drop straight into the deck.",
    body:
      "Five forms, chosen from the shape of the result — and if you asked the AI for a line graph, you get a line graph. Axes are picked with an eye for what a number means: an id is not a measure, and neither is a year.",
    points: [
      "Bar, line, area, scatter, donut, with the categorical palette in fixed order — no invented ninth colour.",
      "Transparent PNG at 2×: a serialisation of the SVG, not a screenshot, so it is sharp and has no white box.",
      "The numbers stay one click away, because a chart nobody can check is decoration.",
    ],
  },
  {
    id: "vector",
    kicker: "Embeddings",
    title: "A vector column you can actually read.",
    body:
      "A `vector(1536)` is twenty kilobytes of digits, so every other client prints twenty kilobytes of digits. Plinth decodes pgvector's binary format and shows you the fingerprint instead.",
    points: [
      "A sparkline, the dimension count and the norm — enough to tell two rows apart and to spot an un-normalised vector instantly.",
      "vector, halfvec and sparsevec, including half-precision decoding.",
      "Right-click → Find similar rows: the nearest-neighbour query, anchored to the row by key, with the other metrics documented in the SQL.",
    ],
  },
  {
    id: "editor",
    kicker: "The editor",
    title: "An editor that has read your database.",
    body:
      "CodeMirror 6 with the schema wired into it. A name that is a table reads as a table; a name that is a column reads as a column — which no other client does, because the SQL grammar alone cannot tell them apart.",
    points: [
      "JOIN completion from the foreign-key graph: the whole clause, ranked first, labelled as a foreign key.",
      "Alias-aware columns, rainbow brackets, indentation guides, folding, multi-cursor, find and replace.",
      "Errors are underlined where the server said they were — line and column, not a toast.",
    ],
  },
];

// ─────────────────────────── the comparison ───────────────────────────

export type Cell = { v: "yes" | "no" | "paid" | "part"; t: string };

export interface CompareRow {
  label: string;
  cells: [Cell, Cell, Cell, Cell];
}

export const COMPARE_COLUMNS = ["Plinth", "TablePlus", "DBeaver CE", "DataGrip"];

/** Checked against each product's own documentation and pricing pages.
 *  Anything here that has gone stale is a bug — say so. */
export const COMPARE: CompareRow[] = [
  {
    label: "Local LLM, nothing sent to a cloud",
    cells: [
      { v: "yes", t: "any Ollama model" },
      { v: "no", t: "—" },
      { v: "paid", t: "PRO only — and the most-upvoted community request" },
      { v: "part", t: "AI assistant, cloud by default" },
    ],
  },
  {
    label: "MCP server for coding agents",
    cells: [
      { v: "yes", t: "read-only, audited" },
      { v: "no", t: "—" },
      { v: "no", t: "—" },
      { v: "no", t: "—" },
    ],
  },
  {
    label: "Schema diff with migration SQL",
    cells: [
      { v: "yes", t: "built in" },
      { v: "no", t: "asked for since 2019, still open" },
      { v: "paid", t: "PRO only" },
      { v: "yes", t: "built in" },
    ],
  },
  {
    label: "Query plan diagnosed in plain English",
    cells: [
      { v: "yes", t: "seven rules, offline" },
      { v: "part", t: "plan tree, no diagnosis" },
      { v: "part", t: "plan tree, no diagnosis" },
      { v: "part", t: "plan diagram, no diagnosis" },
    ],
  },
  {
    label: "Type-the-table-name gate on unbounded writes",
    cells: [
      { v: "yes", t: "parser-backed" },
      { v: "part", t: "a confirm dialog" },
      { v: "part", t: "a confirm dialog" },
      { v: "part", t: "a confirm dialog" },
    ],
  },
  {
    label: "pgvector shown as something legible",
    cells: [
      { v: "yes", t: "sparkline, dim, norm" },
      { v: "no", t: "raw text" },
      { v: "no", t: "raw text" },
      { v: "no", t: "raw text" },
    ],
  },
  {
    label: "Tabs in the free tier",
    cells: [
      { v: "yes", t: "unlimited" },
      { v: "no", t: "two" },
      { v: "yes", t: "unlimited" },
      { v: "no", t: "trial only" },
    ],
  },
  {
    label: "Price",
    cells: [
      { v: "yes", t: "free, open source" },
      { v: "paid", t: "$99 to lift the limits" },
      { v: "paid", t: "free core, PRO subscription" },
      { v: "paid", t: "~$99 a year" },
    ],
  },
];

/** The honest half. A tour that only lists wins is an advertisement. */
export const NOT_YET: string[] = [
  "The local models are the weak half of the local AI. Asked to rewrite a slow query, llama3.1:8b returned SQL PostgreSQL refused to parse on two attempts out of three. Nothing it writes is trusted — every statement is measured or shown to you first — so a bad answer costs nothing but a moment. But \"local AI\" promises more than an 8B model delivers today.",
  "Visual EXPLAIN is Postgres only — MySQL's plan JSON has a different shape and is refused with a clear message rather than guessed at.",
  "SSH tunnels and AWS SSM are designed but not built.",
  "MongoDB and Redis are not here yet; Postgres, MySQL/MariaDB and SQLite are.",
  "Schema diff compares two databases you have open — not a database against a migrations folder.",
];
