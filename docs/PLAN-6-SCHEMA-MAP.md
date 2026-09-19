# Plan 6 — Schema Map

One artefact, two jobs. A map a person can read, and a graph the model can
walk. Both come from the same index, built once per connection.

## 0. Why a graph, not just a picture

Schema linking is the accuracy bottleneck in text-to-SQL, and the current
state of the art is exactly this feature:
[SchemaGraphSQL](https://arxiv.org/abs/2505.18363) (EACL 2026 Findings) builds
a graph from foreign keys, asks a small model only for the *source and
destination* tables, then uses classical path-finding to derive the join path —
beating fine-tuned and multi-step approaches on BIRD and Spider 2.0. It also
adds a joinability-discovery step for databases whose foreign keys are missing,
which is most legacy MySQL.

That is the whole design. The picture is the same data with a layout.

Concretely it fixes the failure we already see with an 8B model: it knows the
columns but guesses the `ON` clause. With a path in context it does not guess.

## 1. What we are not building

| Need | Use | Licence |
|---|---|---|
| Node canvas, pan/zoom/selection | [React Flow](https://github.com/xyflow/xyflow) — ships a Database Schema Node | MIT |
| Graph layout | [`@dagrejs/dagre`](https://github.com/dagrejs/dagre) | MIT |
| — | not `elkjs`: EPL-2.0, awkward next to AGPL-3.0 | — |

Azimutt, ChartDB and drawDB are whole apps, not libraries; nothing to embed.
Azimutt's premise — that big schemas must be searched and traced, never drawn
all at once — is the one we copy.

## 2. Where the edges come from

`Driver::foreign_keys()` returns every declared edge in the database in one
round trip, not per table:

| Driver | Query |
|---|---|
| Postgres | `pg_constraint` where `contype = 'f'`, joined to both relations |
| MySQL | `information_schema.KEY_COLUMN_USAGE` where `referenced_table_name is not null` |
| SQLite | `pragma_foreign_key_list` joined over `sqlite_master` |

### Inferred edges ⚠︎

A database with no declared foreign keys still has relationships, and a map
that shows nothing is worse than useless. So we infer, conservatively, in
`plinth-core` (pure, testable, no driver involvement):

- a column named `x_id` / `xId`, where a table `x` or `xs` exists
- whose target column is that table's single-column primary key
- and whose wire type matches

Inferred edges are marked `inferred: true`, drawn dashed, and labelled as a
guess in the model's context. We never present a guess as a constraint.

## 3. The map

A tab kind, not a modal — it stays open beside a query.

- nodes are tables, sized by column count, labelled with row estimate
- `⌘F`-style filter narrows to matching tables **and their immediate
  neighbours**, so a 400-table schema is readable
- click a node → open that table; `⌥`-click → add it to the AI context as a pin
- dashed edges are inferred; solid are declared
- layout from dagre, left-to-right, cached per workspace so it does not jump

## 4. What the model gets

`buildContext` gains a **Joins** section. For the tables in play — pinned,
`@mentioned`, or named in the question — we emit the shortest path between
each pair as literal SQL:

```
public.orders.customer_id = public.customers.id
public.order_items.order_id = public.orders.id   (inferred)
```

This is cheap: BFS over an adjacency map we already hold. It costs a few dozen
tokens and removes the single most common class of wrong answer.

## 5. TODO

- [x] `Driver::foreign_keys()` + Postgres / MySQL / SQLite implementations
      (Postgres covered by a live test; MySQL and SQLite written, untested —
      no server, and the SQLite path needs a file with declared keys)
- [x] `Engine::schema_graph` with conservative inference
- [x] `schema_graph` command, mirrored types, mock
- [x] Join-path index + BFS; wired into `buildContext`
- [x] Map tab: React Flow + dagre, filter keeps neighbours, dashed inferred
      edges, double-click opens the table
- [x] Tests: 5 inference tests in `graph.rs`, live Postgres FK test
- [ ] Per-workspace layout cache so the map does not re-flow on every filter
- [ ] `⌥`-click a node to pin it into the AI context
- [ ] Minimap — React Flow's rendered no nodes for our custom node type;
      dropped rather than debugged, the filter covers the same need
