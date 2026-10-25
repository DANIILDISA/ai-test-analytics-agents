// web/frontend/src/types/chat.test.ts
import { describe, it, expect } from "vitest";
import { isCardBlock, isTextBlock, CARD_TYPES, EFFORTS, contextRunIds } from "@/types/chat";
import type { Block, StatsCard, ListCard, RunsCard, CompareCard, ThreadContext } from "@/types/chat";

describe("block discriminants", () => {
  it("narrows a text block", () => {
    const b: Block = { type: "text", text: "привет" };
    expect(isTextBlock(b)).toBe(true);
    expect(isCardBlock(b)).toBe(false);
  });

  it("narrows a card block", () => {
    const card: StatsCard = { type: "stats", title: "T", metrics: [{ label: "L", value: "1" }] };
    const b: Block = { type: "card", card };
    expect(isCardBlock(b)).toBe(true);
    if (isCardBlock(b)) expect(b.card.type).toBe("stats");
  });

  it("exposes the four card-type tags exactly as Plan 1 emits them", () => {
    expect(CARD_TYPES).toEqual(["stats", "list", "runs", "compare"]);
  });

  it("exposes the three effort values exactly as Plan 1/3 use them", () => {
    expect(EFFORTS).toEqual(["low", "medium", "high"]);
  });

  it("compiles each card shape with its exact Plan 1 fields", () => {
    const list: ListCard = { type: "list", title: "L", items: [{ text: "q", value: "7%" }] };
    const runs: RunsCard = {
      type: "runs",
      title: "R",
      items: [{ id: "r1", name: "069", course_id: "069", avg_score: 70.3, critical: 2 }],
    };
    const cmp: CompareCard = {
      type: "compare",
      title: "C",
      rows: [{ label: "Средний балл", a: 60, b: 70, delta: 10 }],
    };
    expect(list.items[0].text).toBe("q");
    expect(runs.items[0].avg_score).toBe(70.3);
    expect(cmp.rows[0].delta).toBe(10);
  });
});

describe("contextRunIds", () => {
  it("returns [] for null context", () => {
    expect(contextRunIds(null)).toEqual([]);
  });

  it("returns [] for an empty context", () => {
    expect(contextRunIds({})).toEqual([]);
  });

  it("uses runs and preserves order", () => {
    const ctx: ThreadContext = { runs: ["a", "b", "c"] };
    expect(contextRunIds(ctx)).toEqual(["a", "b", "c"]);
  });

  it("filters falsy entries out of runs", () => {
    const ctx = { runs: ["a", "", "b", undefined, "c"] } as unknown as ThreadContext;
    expect(contextRunIds(ctx)).toEqual(["a", "b", "c"]);
  });

  it("returns [] for an empty runs array", () => {
    expect(contextRunIds({ runs: [] })).toEqual([]);
  });

  it("prefers runs over compare and run_id", () => {
    const ctx: ThreadContext = { runs: ["r1"], compare: ["x", "y"], run_id: "z" };
    expect(contextRunIds(ctx)).toEqual(["r1"]);
  });

  it("uses compare (both ids, in order) when runs is absent", () => {
    const ctx: ThreadContext = { compare: ["x", "y"] };
    expect(contextRunIds(ctx)).toEqual(["x", "y"]);
  });

  it("prefers compare over run_id when runs is absent", () => {
    const ctx: ThreadContext = { compare: ["x", "y"], run_id: "z" };
    expect(contextRunIds(ctx)).toEqual(["x", "y"]);
  });

  it("uses run_id when runs and compare are absent", () => {
    const ctx: ThreadContext = { run_id: "z" };
    expect(contextRunIds(ctx)).toEqual(["z"]);
  });

  it("returns a fresh array (does not alias the input runs)", () => {
    const ctx: ThreadContext = { runs: ["a", "b"] };
    expect(contextRunIds(ctx)).not.toBe(ctx.runs);
  });
});
