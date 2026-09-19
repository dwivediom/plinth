import { describe, expect, it } from "vitest";
import { tableFromSql } from "./writeGate";

/**
 * The word the confirmation asks you to type. Getting it wrong is worse than
 * having no confirmation: it teaches people to type whatever is in bold.
 * `CREATE INDEX ON public.orders (status)` used to ask for `ON`.
 */
describe("tableFromSql", () => {
  const cases: [string, string | null][] = [
    // index DDL: the table is after ON, never after INDEX
    ["CREATE INDEX ON public.orders (status);", "orders"],
    ["CREATE UNIQUE INDEX CONCURRENTLY idx_x ON public.perf_orders (customer_id, status)", "perf_orders"],
    ["CREATE INDEX IF NOT EXISTS idx_y ON orders (placed_at)", "orders"],
    // the ordinary shapes
    ["delete from orders where id = 1", "orders"],
    ["DELETE FROM public.perf_orders", "perf_orders"],
    ['update "orders" set status = \'paid\'', "orders"],
    ["insert into orders (id) values (1)", "orders"],
    ["DROP TABLE IF EXISTS legacy_carts", "legacy_carts"],
    ["ALTER TABLE orders ADD COLUMN trial boolean", "orders"],
    ["TRUNCATE public.events", "events"],
    ["DROP VIEW customer_totals", "customer_totals"],
    ["DROP INDEX IF EXISTS orders_status_idx", "orders_status_idx"],
    // a join condition is not a target
    ["DELETE a FROM accounts a JOIN batches b ON b.id = a.batch_id", "accounts"],
    ["UPDATE orders o SET status = 'x' FROM batches b WHERE b.id = o.batch_id", "orders"],
    // nothing to name
    ["VACUUM", null],
  ];

  it.each(cases)("%s → %s", (sql, want) => {
    expect(tableFromSql(sql)).toBe(want);
  });
});
