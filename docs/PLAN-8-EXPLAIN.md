# Plan 8 — Visual EXPLAIN

## 0. The problem

Every client dumps `EXPLAIN ANALYZE` as a wall of indented text, so people
paste their plans into a website. The honest objection is not "a public leak"
— it is **third-party egress**: on the hosted explain.dalibo.com, plans are
stored server-side by default, and a plan carries your table names, column
names, index names and row counts. That is your schema, on someone else's
disk, to answer a question your own client could have answered.

Nothing about reading a plan requires a server. The plan is already JSON, the
rules are arithmetic, and we already draw node graphs.

## 1. No new backend

`EXPLAIN (FORMAT JSON) <query>` is a query. It goes through `query_run` like
everything else — same policy engine, same console, same audit line. The plan
comes back as one JSON cell.

**`ANALYZE` executes the statement.** `policy.rs` already knows this. So the
Analyze path runs `sql_check` on the *inner* statement first and is refused
unless it is read-only — you cannot accidentally `EXPLAIN ANALYZE` a `DELETE`.

The captured plan is stored on the tab. Re-opening a plan tab never re-runs
the query: with `ANALYZE` that would execute it again.

## 2. The arithmetic that matters

Two subtleties decide whether the picture tells the truth:

- **Times are per-loop averages.** A node's real cost is
  `Actual Total Time × Actual Loops`. A nested loop's inner side reporting
  0.004 ms over 50,000 loops is 200 ms, not 0.004 ms.
- **Self time, not total time.** A node's own cost is its inclusive time minus
  its children's. Colouring by total time paints the root red every time and
  tells you nothing.

Rows get the same treatment: `Actual Rows × Loops`.

## 3. Hazards — rules, not a model

Deterministic, computed locally, each one a sentence a person can act on.

| Rule | Fires when | Says |
|---|---|---|
| Sequential scan | `Seq Scan`, rows ≥ 50k | reading the whole table |
| Bad estimate | planner off by ≥ 100× (needs ANALYZE) | the planner guessed wrong; stale statistics |
| Sort spilled | `Sort Space Type: Disk` | the sort did not fit in `work_mem` |
| Hash spilled | `Hash Batches > 1` | the hash did not fit in `work_mem` |
| Hot loop | nested-loop inner side with ≥ 1,000 loops | run N times, not once |
| Discarded rows | `Rows Removed by Filter` ≥ 10× rows kept | a filter read far more than it returned; index candidate |
| Dominant node | self time ≥ 40% of execution | this node *is* the query |

A model may phrase these; it never decides them.

## 4. The picture

React Flow, laid out top-down with dagre — the same pair the schema map uses.

- each node is a card: type, relation, a **heat meter** of its self-time share,
  actual rows against planned
- heat is **one hue, light → dark** (the sequential rule), not a rainbow;
  hazards are status colours with an icon and a word, never colour alone
- edge width follows rows flowing through it, on a log scale, so the fat pipe
  is visible at a glance
- a side panel lists the hazards in plain English; clicking one selects and
  centres its node, and shows every field the plan carries for it
- the header states the total, the planning time, and that **nothing left this
  machine**

## 5. Optimize — the plan, and what to do about it

`Explain` answers "why is this slow". The button beside it answers "what would
fix it", and the rule that makes it trustworthy is the same one §3 states for
hazards: **the app proposes, the planner decides.**

### Where candidates come from

- **Indexes, from the plan.** A scan with a `Filter` that discards most of
  what it reads; the inner side of a nested loop with a join condition; a sort
  that spilled. Columns come out of the predicate Postgres printed —
  equalities first, then ranges, which is the order a composite index has to
  be in — and are then checked against the schema, so a suggestion is never
  an index on something that is not a column.
- **A rewrite, from the local model**, when one is configured. Optional. The
  rules work with no model at all.

### Every candidate is measured

`EXPLAIN` runs again with the candidate in place and the planner's cost is
compared. An index is tested with **HypoPG** — a hypothetical index the
planner can see and nobody has to build.

This needs one connection: HypoPG keeps hypothetical indexes in the session's
private memory, and our pool would hand the `EXPLAIN` to a connection that had
never heard of it — which looks exactly like "this index would not help". So
`Driver::explain_hypothetical` pins reset → create → plan → reset to a single
acquired connection. Nothing else in the API needs that, and `execute` cannot
promise it.

Two honest limits, both stated in the UI:

- HypoPG is invisible to `EXPLAIN ANALYZE`, so index candidates are scored on
  **estimated cost**, not measured time.
- Without the extension the candidates still appear, with the arithmetic that
  motivated them, labelled *not measured*.

### What measuring actually caught

On a 500,000-row table with a genuinely complicated query (join, filter,
group, having, window, order, limit) the rules proposed two indexes. The
planner scored them **41%** and **0%**. Building both by hand confirmed it:
cost 10,960 → 6,217, time ~19 ms → 6.8 ms, and the second index contributed
nothing. A tool without measurement would have told you to build both.

The model half was caught too. Asked to rewrite a query whose two correlated
subqueries scan 500,000 rows per customer row, a local llama3.1:8b returned
SQL that Postgres refused to parse (`missing FROM-clause entry for table "c"`)
on two runs out of three, and on the third returned the original query with
the same subqueries and a 0% cost change. **A refused rewrite is counted and
not shown**; an unimproved one is shown as no improvement. The verification is
not a safety net around the feature — it is the feature.

## 6. TODO

- [x] `lib/explain.ts`: parse, loop-correct, self-time, seven hazard rules —
      verified against a real captured plan (inner sort 8.71 ms self of
      9.57 ms inclusive; spill and dominance both found)
- [x] Plan tab kind holding the captured JSON — never re-runs
- [x] Explain / Explain Analyze in the query bar, with the read-only gate
- [x] `PlanView`: React Flow canvas, root on top, self-time heat on a
      validated one-hue ramp, edge width by rows, hazard panel that selects
      and centres its node
- [ ] MySQL (`EXPLAIN FORMAT=JSON` has a different shape) — refused with a
      clear message today
- [ ] A "copy plan" button, for when someone *does* want to share it
- [x] Optimize: index candidates from the plan, scored with HypoPG on one
      pinned connection; model rewrites, scored by `EXPLAIN`, discarded when
      the server refuses them
- [ ] Compare results, not just cost: run both sides with the same LIMIT and
      check the rows match, so a rewrite can be shown to be equivalent
- [ ] Multi-column candidates across statements (a workload, not one query)
