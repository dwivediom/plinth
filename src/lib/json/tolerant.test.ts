import { describe, expect, it } from "vitest";
import { jsonPath, valueAt } from "./model";
import { parseTolerant } from "./tolerant";

describe("valid JSON", () => {
  it("parses with nothing to report", () => {
    const r = parseTolerant('{"a":1,"b":[true,null,"x"]}');
    expect(r.issues).toEqual([]);
    expect(valueAt(r.doc, 0)).toEqual({ a: 1, b: [true, null, "x"] });
  });
});

describe("the everyday not-quite-JSON", () => {
  const r = parseTolerant("{ /* config */ name: 'ada', port: 8080, tags: [\"x\",], ok: NaN, }");

  it("opens anyway", () => {
    // `ok` stays a real NaN rather than becoming null: the parser is lenient,
    // not lossy. Repair turns it into `null` on the way out, because that is
    // the only thing valid JSON can say about it.
    expect(valueAt(r.doc, 0)).toEqual({ name: "ada", port: 8080, tags: ["x"], ok: NaN });
  });

  it("reports every deviation without calling any of them errors", () => {
    expect(r.issues.map((i) => i.message)).toEqual([
      "Block comment — not valid JSON",
      "Unquoted key — JSON requires quotes",
      "Single-quoted string — JSON uses double quotes",
      "Unquoted key — JSON requires quotes",
      "Unquoted key — JSON requires quotes",
      "Trailing comma",
      "Unquoted key — JSON requires quotes",
      "NaN is not valid JSON",
      "Trailing comma",
    ]);
    expect(r.issues.every((i) => i.kind === "lenient")).toBe(true);
  });
});

describe("real mistakes", () => {
  it("points at the path of a missing value", () => {
    const r = parseTolerant('{"user":{"name":"ada","age":},"ok":true}');
    expect(valueAt(r.doc, 0)).toEqual({ user: { name: "ada", age: null }, ok: true });
    const err = r.issues.find((i) => i.kind === "error")!;
    expect(err.path).toBe("$.user.age");
    expect(jsonPath(r.doc, err.node)).toBe("$.user.age");
  });

  it("charges one member for one bad member, and reports it once", () => {
    const r = parseTolerant('{"a":1,"b":@@@,"c":3,"d":4}');
    expect(Object.keys(valueAt(r.doc, 0) as object)).toEqual(["a", "b", "c", "d"]);
    expect(r.issues.filter((i) => i.kind === "error")).toHaveLength(1);
  });

  it("keeps what it read from a truncated file and says where it stopped", () => {
    const r = parseTolerant('{"rows":[{"id":1},{"id":2},{"id":');
    expect(r.truncated).toBe(true);
    expect((valueAt(r.doc, 0) as { rows: unknown[] }).rows).toHaveLength(3);
    expect(r.issues.at(-1)!.message).toMatch(/ends/);
  });

  it("reports a second document rather than failing on it", () => {
    const r = parseTolerant('{"a":1}\n{"b":2}');
    expect(r.issues.map((i) => i.message)).toEqual([expect.stringContaining("Extra content")]);
    expect(valueAt(r.doc, 0)).toEqual({ a: 1 });
  });
});

describe("depth", () => {
  it("does not recurse — the first version overflowed here", () => {
    const deep = "[".repeat(50_000) + "1" + "]".repeat(50_000);
    expect(parseTolerant(deep).doc.nodes).toHaveLength(50_001);
  });
});
