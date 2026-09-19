import { describe, expect, it } from "vitest";
import type { ColumnDesc } from "../ipc/types";
import { COMBINED, chooseColumns } from "./chartColumns";

const col = (name: string, logical: string): ColumnDesc =>
  ({ name, dataType: logical, logical, wire: logical, nullable: true }) as unknown as ColumnDesc;

const AGGREGATE_SQL =
  "SELECT EXTRACT(YEAR FROM placed_at) AS year, EXTRACT(MONTH FROM placed_at) AS month, COUNT(*) AS num_orders " +
  "FROM orders WHERE placed_at >= NOW() - INTERVAL '3 month' GROUP BY year, month ORDER BY year, month LIMIT 5;";

describe("chooseColumns", () => {
  it("does not put the same column on both axes", () => {
    // The bug this was written for: every column is numeric, so X and Y both
    // defaulted to `year`, the series was filtered out, and the chart said
    // "nothing numeric to plot" over a table full of numbers.
    const columns = [col("year", "decimal"), col("month", "decimal"), col("num_orders", "int")];
    const rows = [
      [2026, 7, 12],
      [2026, 8, 31],
      [2026, 9, 9],
    ];
    const r = chooseColumns(columns, rows, AGGREGATE_SQL, null, null, 8);
    expect(r.labelColumn).toBe(COMBINED);
    expect(r.combinedOf).toEqual(["year", "month"]);
    expect(r.valueColumns).toEqual(["num_orders"]);
    expect(r.measures.map((c) => c.name)).toEqual(["num_orders"]);
  });

  it("reads GROUP BY ordinals as dimensions", () => {
    const columns = [col("region", "text"), col("tier", "int"), col("revenue", "decimal")];
    const rows = [
      ["EU", 1, 10],
      ["EU", 2, 20],
      ["US", 1, 5],
    ];
    const r = chooseColumns(columns, rows, "select region, tier, sum(amount) as revenue from sales group by 1, 2", null, null, 8);
    expect(r.labelColumn).toBe(COMBINED);
    expect(r.valueColumns).toEqual(["revenue"]);
  });

  it("leaves the ordinary one-dimension aggregate alone", () => {
    const columns = [col("status", "text"), col("n", "int")];
    const r = chooseColumns(columns, [["paid", 4], ["refunded", 1]], "SELECT status, count(*) AS n FROM orders GROUP BY status", null, null, 8);
    expect(r.labelColumn).toBe("status");
    expect(r.valueColumns).toEqual(["n"]);
  });

  it("never treats an id as a measure", () => {
    const columns = [col("id", "int"), col("customer_id", "int"), col("status", "text"), col("amount", "decimal")];
    const r = chooseColumns(columns, [[1, 7, "paid", 10], [2, 8, "paid", 20]], "select * from orders limit 50", null, null, 8);
    expect(r.labelColumn).toBe("status");
    expect(r.valueColumns).toEqual(["amount"]);
  });

  it("does not combine the dimensions of a raw SELECT *", () => {
    // Combining there gives one label per row, which is not an axis.
    const columns = [col("id", "int"), col("customer_id", "int"), col("status", "text"), col("amount", "decimal")];
    const r = chooseColumns(columns, [[1, 7, "paid", 10], [2, 8, "paid", 20]], "select * from orders", null, null, 8);
    expect(r.combinedOf).toEqual([]);
  });

  it("does not combine when no measure would survive it", () => {
    const columns = [col("status", "text"), col("amount", "decimal")];
    const r = chooseColumns(columns, [["paid", 10], ["paid", 20], ["refunded", 5]], "select status, amount from public.orders group by 1, 2", null, null, 8);
    expect(r.labelColumn).toBe("status");
    expect(r.valueColumns).toEqual(["amount"]);
  });

  it("respects a hand-picked X and keeps Y clear of it", () => {
    const columns = [col("year", "decimal"), col("month", "decimal"), col("num_orders", "int")];
    const rows = [[2026, 7, 12], [2026, 8, 31]];
    expect(chooseColumns(columns, rows, AGGREGATE_SQL, "month", null, 8).valueColumns).toEqual(["num_orders"]);
    expect(chooseColumns(columns, rows, AGGREGATE_SQL, "month", ["month"], 8).valueColumns).toEqual([]);
  });

  it("leaves distinct labels uncombined", () => {
    const columns = [col("year", "decimal"), col("month", "decimal"), col("num_orders", "int")];
    expect(chooseColumns(columns, [[2026, 7, 12], [2025, 7, 9]], AGGREGATE_SQL, null, null, 8).labelColumn).toBe("year");
  });

  it("has nothing to plot against a lone measure", () => {
    const r = chooseColumns([col("total", "int")], [[42]], "select count(*) as total from orders", null, null, 8);
    expect(r.labelColumn).toBe("total");
    expect(r.valueColumns).toEqual([]);
  });
});
