import { describe, expect, it } from "vitest";
import type { SchemaIndex } from "../ipc/types";
import { parsePlan } from "./explain";
import { createIndexSql, describeGain, indexCandidates, predicateColumns, sortColumns, totalCost } from "./optimize";

/**
 * The fixture is a real `EXPLAIN (ANALYZE, FORMAT JSON)` captured from
 * Postgres 17 against a 500,000-row table — not a handwritten plan. Plans are
 * the one input where inventing the shape defeats the purpose.
 */
// Imported rather than read from disk: the app's tsconfig has no node types
// on purpose, so that app code cannot reach for `fs` and break in the webview.
import planFixture from "./__fixtures__/plan-seq-scan.json";
const planJson = JSON.stringify(planFixture);

const schema = {
  schemas: [],
  columns: [
    ...["id", "customer_id", "status", "amount", "placed_at", "note"].map((column) => ({ schema: "public", table: "perf_orders", column })),
    ...["id", "name", "country", "tier", "created_at"].map((column) => ({ schema: "public", table: "perf_customers", column })),
  ],
} as unknown as SchemaIndex;

describe("predicateColumns", () => {
  it("puts equalities before ranges — the order a composite index needs", () => {
    expect(predicateColumns("((status = 'paid'::text) AND (placed_at >= (now() - '90 days'::interval)))")).toEqual([
      { column: "status", equality: true },
      { column: "placed_at", equality: false },
    ]);
  });

  it("takes the column from a qualified name", () => {
    expect(predicateColumns("(c.id = o.customer_id)")).toEqual([{ column: "id", equality: true }]);
  });

  it("does not propose an index on a function call", () => {
    // `lower(email) = …` wants an expression index, which is not something to
    // suggest without being asked.
    expect(predicateColumns("(lower(email) = 'a@b'::text)")).toEqual([]);
  });

  it("reads an IN list as an equality", () => {
    expect(predicateColumns("(country = ANY ('{US,DE,IN}'::text[]))")).toEqual([{ column: "country", equality: true }]);
  });
});

describe("sortColumns", () => {
  it("drops the direction and the qualifier", () => {
    expect(sortColumns(["o.placed_at DESC", "c.id", "amount DESC NULLS LAST"])).toEqual(["placed_at", "id", "amount"]);
  });
});

describe("indexCandidates", () => {
  const plan = parsePlan(planJson)!;

  it("reads the plan, not the SQL", () => {
    const found = indexCandidates(plan, schema).map(createIndexSql);
    expect(found).toContain("CREATE INDEX ON public.perf_orders (status, placed_at);");
    expect(found).toContain("CREATE INDEX ON public.perf_customers (country);");
  });

  it("explains itself in rows read versus rows kept", () => {
    const orders = indexCandidates(plan, schema).find((c) => c.relation === "perf_orders")!;
    expect(orders.reason).toMatch(/read [\d,]+ rows and kept [\d,]+/);
  });

  it("drops columns a known table does not have", () => {
    // The plan prints aliases and expressions too; an index on something that
    // is not a column is noise.
    const partial = { schemas: [], columns: [{ schema: "public", table: "perf_orders", column: "id" }] } as unknown as SchemaIndex;
    expect(indexCandidates(plan, partial).some((c) => c.relation === "perf_orders")).toBe(false);
  });

  it("trusts the plan for a table the schema has never heard of", () => {
    // Deliberate: an unloaded or partially loaded schema must not silently
    // swallow a real suggestion.
    const partial = { schemas: [], columns: [{ schema: "public", table: "perf_orders", column: "id" }] } as unknown as SchemaIndex;
    expect(indexCandidates(plan, partial).find((c) => c.relation === "perf_customers")?.columns).toEqual(["country"]);
  });
});

describe("reporting the gain", () => {
  it("reads the planner's own cost out of a plan", () => {
    expect(totalCost(planJson)).toBeGreaterThan(0);
  });

  it("uses a multiple where a percentage stops carrying information", () => {
    // 99.89% and 99.99% are both "100%"; 938× and 9,380× are not.
    expect(describeGain(199_714_799, 212_816)).toBe("938× cheaper");
    expect(describeGain(1000, 700)).toBe("30% cheaper");
    expect(describeGain(1000, 999)).toBe("no improvement");
    expect(describeGain(1000, null)).toBeNull();
  });
});
