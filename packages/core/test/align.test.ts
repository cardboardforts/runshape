import { describe, expect, test } from "vitest";

import { align, MAX_EDIT_DISTANCE, Op } from "../src/align";

const show = (before: string, after: string) =>
  align([...before], [...after], (c) => c)
    .steps.map((step) => (step.op === Op.Same ? step.after : step.op === Op.Added ? `+${step.after}` : `-${step.before}`))
    .join(" ");

function lcsLength(a: string[], b: string[]): number {
  const table = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i += 1)
    for (let j = 1; j <= b.length; j += 1)
      table[i]![j] = a[i - 1] === b[j - 1] ? table[i - 1]![j - 1]! + 1 : Math.max(table[i - 1]![j]!, table[i]![j - 1]!);
  return table[a.length]![b.length]!;
}

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

    expect(align(before, after, (s) => s).steps.map((step) => step.op)).toEqual([Op.Same, Op.Added, Op.Same, Op.Same, Op.Same, Op.Same]);
  });

  test("on random inputs it always keeps a longest common subsequence, and replays both sides", () => {
    let seed = 7;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const word = () => Array.from({ length: Math.floor(random() * 9) }, () => "abc"[Math.floor(random() * 3)]!);
    for (let i = 0; i < 2000; i += 1) {
      const a = word();
      const b = word();
      const { steps, complete } = align(a, b, (s) => s);
      expect(complete).toBe(true);
      expect(steps.filter((s) => s.op === Op.Same).length, `${a.join("")} / ${b.join("")}`).toBe(lcsLength(a, b));
      expect(steps.filter((s) => s.op !== Op.Added).map((s) => s.before)).toEqual(a);
      expect(steps.filter((s) => s.op !== Op.Removed).map((s) => s.after)).toEqual(b);
    }
  });

  test("past the edit-distance limit it says it gave up rather than claim everything changed", () => {
    const before = Array.from({ length: MAX_EDIT_DISTANCE }, (_, i) => `old${i}`);
    const after = Array.from({ length: MAX_EDIT_DISTANCE }, (_, i) => `new${i}`);

    const { steps, complete } = align(before, after, (s) => s);

    expect(complete).toBe(false);
    expect(steps).toHaveLength(2 * MAX_EDIT_DISTANCE);
  });
});
