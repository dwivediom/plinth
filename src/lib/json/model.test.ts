import { describe, expect, it } from "vitest";
import { ancestors, expandToDepth, filterRows, flatten, jsonPath, search, valueAt, visibleRows } from "./model";

const sample = {
  id: 7,
  name: "Ada",
  active: true,
  address: { city: "London", zip: null },
  tags: ["alpha", "beta"],
};
const doc = flatten(sample, 123);
const keyOf = (i: number) => doc.nodes[i].key;

describe("flatten", () => {
  it("emits every node once, parents before children", () => {
    expect(doc.nodes.length).toBe(1 + 5 + 2 + 2);
    expect(doc.nodes[0]).toMatchObject({ kind: "object", count: 5, parent: -1 });
  });

  it("keeps each subtree contiguous, which is what makes collapsing one jump", () => {
    const address = doc.nodes.findIndex((n) => n.key === "address");
    expect(doc.nodes.slice(address + 1, doc.nodes[address].end).map((n) => n.key)).toEqual(["city", "zip"]);
  });

  it("marks array children as indexed", () => {
    expect(doc.nodes.filter((n) => n.indexed).map((n) => n.key)).toEqual(["0", "1"]);
  });
});

describe("visibleRows", () => {
  it("hides the subtree of a closed container", () => {
    expect(visibleRows(doc, new Set([0]))).toHaveLength(6); // root + 5 keys
  });

  it("shows a subtree when its container is open", () => {
    const address = doc.nodes.findIndex((n) => n.key === "address");
    expect(visibleRows(doc, new Set([0, address]))).toHaveLength(8);
  });

  it("opens only the root at depth 1", () => {
    expect([...expandToDepth(doc, 1)]).toEqual([0]);
  });
});

describe("search", () => {
  const find = (query: string, scope: "all" | "keys" | "values", caseSensitive = false, regex = false) =>
    search(doc, { query, scope, caseSensitive, regex });

  it("separates keys from values — the reason the control exists", () => {
    expect(find("a", "keys").map(keyOf)).toEqual(["name", "active", "address", "tags"]);
    expect(find("a", "values").map((i) => doc.nodes[i].value)).toEqual(["Ada", "alpha", "beta"]);
  });

  it("respects case", () => {
    expect(find("A", "values", true).map((i) => doc.nodes[i].value)).toEqual(["Ada"]);
  });

  it("takes a regular expression", () => {
    expect(find("^be", "values", false, true).map((i) => doc.nodes[i].value)).toEqual(["beta"]);
  });

  it("matches nothing on a bad pattern rather than throwing", () => {
    expect(find("([", "all", false, true)).toEqual([]);
  });

  it("finds null by name", () => {
    expect(find("null", "values").map(keyOf)).toEqual(["zip"]);
  });
});

describe("paths and values", () => {
  it("keeps the way to each match when filtering", () => {
    const hits = search(doc, { query: "city", scope: "keys", caseSensitive: false, regex: false });
    expect(filterRows(doc, hits).map(keyOf)).toEqual([null, "address", "city"]);
  });

  it("writes JSONPath the way every other tool reads it", () => {
    expect(jsonPath(doc, doc.nodes.findIndex((n) => n.key === "city"))).toBe("$.address.city");
    expect(jsonPath(doc, doc.nodes.findIndex((n) => n.key === "1" && n.indexed))).toBe("$.tags[1]");
    expect(jsonPath(flatten({ "a b": 1 }), 1)).toBe('$["a b"]');
  });

  it("rebuilds any subtree", () => {
    expect(valueAt(doc, doc.nodes.findIndex((n) => n.key === "address"))).toEqual({ city: "London", zip: null });
    expect(valueAt(doc, 0)).toEqual(sample);
  });
});

describe("the shapes that kill naive viewers", () => {
  it("survives 20,000 levels of nesting", () => {
    let deep: unknown = "bottom";
    for (let n = 0; n < 20_000; n++) deep = { next: deep };
    const deepDoc = flatten(deep);
    expect(deepDoc.nodes).toHaveLength(20_001);
    expect(ancestors(deepDoc, deepDoc.nodes.length - 1)).toHaveLength(20_000);
  });

  it("stays proportional to what is on screen, not to the document", () => {
    const big = { rows: Array.from({ length: 50_000 }, (_, n) => ({ id: n, email: `user${n}@example.com`, ok: n % 2 === 0 })) };
    const bigDoc = flatten(big, 4_000_000);
    expect(bigDoc.nodes).toHaveLength(1 + 1 + 50_000 * 4);
    // Root and the array open, every record closed: 50,002 rows, not 200,002.
    expect(visibleRows(bigDoc, new Set([0, 1]))).toHaveLength(2 + 50_000);
    expect(search(bigDoc, { query: "user49999@", scope: "values", caseSensitive: false, regex: false })).toHaveLength(1);
  });
});
