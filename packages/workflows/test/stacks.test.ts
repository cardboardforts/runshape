/**
 * Stacked pull requests: one PR's base branch is another's head branch (#9 builds on #8 builds
 * on #7). The morning list keeps a stack together, bottom first, since the lower PR is the one
 * to review (and merge) first and the upper ones only show what they add on top of it.
 */
import { describe, expect, test } from "vitest";

import type { PullRequestSummary } from "@runshape/kernel";
import { stackOrder } from "../src/stacks";

function pr(number: number, headRefName: string, baseRefName = "main", isCrossRepository = false): PullRequestSummary {
  return { number, title: `PR ${number}`, url: "", author: "teammate", baseRefName, headRefName, headRefOid: "0".repeat(40), isCrossRepository, updatedAt: "2026-10-26T02:00:00Z" };
}

/** "#9 on #8": each PR in order, and what it's stacked on. */
function order(prs: PullRequestSummary[]): string[] {
  return stackOrder(prs).map(({ pr, stackedOn }) => `#${pr.number}${stackedOn === null ? "" : ` on #${stackedOn}`}`);
}

describe("stackOrder", () => {
  test("a stack listed top first comes out bottom first, kept together; the rest keep their place", () => {
    expect(order([pr(9, "c", "b"), pr(3, "x"), pr(8, "b", "a"), pr(7, "a")])).toEqual(["#3", "#7", "#8 on #7", "#9 on #8"]);
  });

  test("two PRs on one base are both on it, in number order; a PR on a branch nobody asked about stands alone", () => {
    expect(order([pr(12, "e", "a"), pr(7, "a"), pr(11, "d", "a"), pr(20, "z", "someone-elses")])).toEqual(["#7", "#11 on #7", "#12 on #7", "#20"]);
  });

  test("a fork's branch name says nothing about ours: a PR on 'a' isn't stacked on a fork's 'a'", () => {
    expect(order([pr(7, "a", "main", true), pr(8, "b", "a")])).toEqual(["#7", "#8"]);
  });

  test("two of ours with one branch name: a PR on that name is on neither (second-model review)", () => {
    expect(order([pr(5, "a"), pr(6, "a", "develop"), pr(7, "b", "a")])).toEqual(["#5", "#6", "#7"]);
  });

  test("branches based on each other in a loop (not possible on GitHub, but data is data) are each listed once", () => {
    expect(order([pr(1, "a", "b"), pr(2, "b", "a")])).toEqual(["#1", "#2 on #1"]);
  });
});
