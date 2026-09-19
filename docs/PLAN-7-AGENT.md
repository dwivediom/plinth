# Plan 7 — The Agent Harness, and Charts

## 0. The failure this fixes

Asked "which customer gives most orders", an 8B model answered:

```sql
SELECT name FROM customers ORDER BY id IN (SELECT customer_id FROM orders GROUP BY customer_id ORDER BY COUNT(*) DESC LIMIT 1) LIMIT 1
```

Valid SQL. Runs. Returns a row. And it is wrong — `ORDER BY id IN (…)` sorts by a
boolean, so the "answer" is an arbitrary customer. One shot at a small model,
with no way to check itself, produces confident nonsense.

The fix is not a longer prompt. It is a loop: let the model look at the schema
and the actual values, write SQL, **run it**, read what came back, and only
then answer — showing each step, the way a person would work.

## 1. Steps

One structured reply per step, chosen from a fixed set. The harness executes
the step, appends the observation, and asks again. At most six steps.

| Step | What the harness does | Cost |
|---|---|---|
| `inspect` | `table_describe` — types, keys, foreign keys | one round trip |
| `sample` | five rows, values truncated — what the data *looks* like | one query |
| `probe` | run read-only SQL, `LIMIT 5`, feed the rows back | one query |
| `answer` | prose, one statement, tables used, assumptions | ends the loop |

`sample` is the step that stops the guessing: a model that has seen
`status = 'refunded'` stops inventing `status = 'REFUND'`.

### Verification ⚠︎

When the answer carries read-only SQL, the harness runs it with `LIMIT 5`
before showing it. An error, or zero rows, goes back to the model once as an
observation. The result is labelled honestly: **verification catches errors and
empty results, not wrongness** — the query above would have passed. What
catches that is `inspect` and `sample` earlier in the loop.

## 2. Auto and manual

- **Auto** — read-only steps run as they come. The loop stops at six steps or
  at the answer.
- **Manual** — every step is proposed with its reasoning and waits for Run or
  Skip. The same steps, with a hand on each one.

Neither mode may write. `probe` goes through `sql_check` and is refused unless
the statement is read-only and single — the agent cannot write, in any mode.

## 3. Writes need a person ⚠︎

A write only ever reaches the database through the person pressing Run on the
final answer, and then:

| Statement | Gate |
|---|---|
| `SELECT` | runs |
| `INSERT` / `UPDATE` / `DELETE` with a `WHERE` | confirmation dialog naming the statement |
| `UPDATE` / `DELETE` with no `WHERE`, or DDL | **type the table name** to confirm |
| anything, with safe mode on | refused outright |

Typing the table name is deliberate friction, borrowed from every "delete this
repository" dialog. It is the difference between a slip and a decision.

## 4. Charts

A result set is a table until someone asks it a shape question. When the
person asks for a chart, or presses the chart toggle on a results pane, the
harness picks a form from the data — and `dataviz` decides how it looks.

- bar, line, area, scatter, donut — if the question names one ("a line graph
  of…") that is the answer; otherwise guessed from the wording, and changeable
  in the tab either way
- **a number is not a measure.** Identifiers (`id`, `*_id`), time parts
  (`year`, `month`, `day`, …) and anything the `GROUP BY` names describe the
  row; only what is left over is plotted. An id beside a real measure is the
  dual-axis mistake in disguise, and `year` against `year` is no chart at all
- the Y default can never land on the X column, and the picker only offers
  columns that are not already on the axis — the two defaults used to collide
  on a result whose every column was numeric, and the chart then said
  "nothing numeric to plot" over a table full of numbers
- several buckets that share the rows become one axis: `2026 · 7`, `2026 · 8`,
  rather than three rows all labelled `2026`. Only for `GROUP BY` buckets, and
  only when a measure survives the fold
- a repeated category is summed, not plotted per row; past eight slices the
  rest folds into "Other"
- the palette is the validated eight, in fixed order, checked against this
  app's own surfaces in both modes — light warns under 3:1, so bars carry
  direct labels and a table view is one click away
- **transparent PNG export**: serialise the SVG, draw to a canvas at 2×, no
  background fill, download. The chart is drawn as SVG precisely so this is a
  serialisation, not a screenshot.

## 5. TODO

- [x] `ai_step` command with the step schema (live test: the model samples
      before answering, and probes with a correct join)
- [x] `agent.ts`: the loop, three read-only tools, six-step budget, retry-once
- [x] Auto / manual toggle, persisted; per-step Run / Skip in manual
- [x] Strict write gate: type-the-table-name for no-`WHERE` and DDL
- [x] Step timeline in the chat: thought, action, collapsible observation
- [x] Charts: five forms in their own full-size tab, transparent PNG at 2×
      (verified by pixel: corner alpha 0, mark `#3b88e5` = series-1)
- [x] Cancel a run in flight — the send button becomes Stop while it works
- [x] Chat polish: steps collapse to one line once answered, growing composer
      (Enter sends, ⇧Enter newline), copy-answer
- [ ] Step budget and sample size in Settings
- [x] Axis choice split out into `lib/chartColumns.ts` and checked case by
      case: the all-numeric aggregate, `GROUP BY 1, 2`, a raw `SELECT *`, a
      lone measure, a hand-picked X
- [ ] Grouped bars from two categorical columns (today one measure at a time,
      which is also what keeps it to one axis)
