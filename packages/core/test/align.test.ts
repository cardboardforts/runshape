import { describe, expect, test } from "vitest";

import { align, Op } from "../src/align";

const show = (before: string, after: string) =>
  align([...before], [...after], (c) => c)
    .map((step) => (step.op === Op.Same ? step.after : step.op === Op.Added ? `+${step.after}` : `-${step.before}`))
    .join(" ");

describe("align", () => {
  test("keeps what both sides share, in order, and marks the rest", () => {
    expect(show("ABCABBA", "CBABAC")).toBe("-A -B C +B A B -B A +C");
    expect(show("", "AB")).toBe("+A +B");
    expect(show("AB", "")).toBe("-A -B");
    expect(show("ABC", "ABC")).toBe("A B C");
  });

  test("an inserted call in the middle of a long run is one addition, not a reshuffle", () => {
    const before = ["route", "slug", "exists", "repo.get", "repo.create"];
    const after = ["route", "ensure", "slug", "exists", "repo.get", "repo.create"];

    expect(align(before, after, (s) => s).map((step) => step.op)).toEqual([Op.Same, Op.Added, Op.Same, Op.Same, Op.Same, Op.Same]);
  });
});
