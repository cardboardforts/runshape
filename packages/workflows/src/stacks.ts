import type { PullRequestSummary } from "@runshape/kernel";

/** A pull request in the morning's order, and the listed one it builds on. */
export interface StackedPullRequest {
  pr: PullRequestSummary;
  /** The listed PR whose head branch this one's base is; null when it's on main, or on a branch nobody asked about. */
  stackedOn: number | null;
}

/**
 * Pull requests with each stack kept together, bottom first: the order to review them in. A
 * PR is stacked on another when its base is that one's head branch, ours (not a fork's, whose
 * branch names are its own). Stacks and lone PRs keep the order the bottom one was listed in.
 */
export function stackOrder(prs: PullRequestSummary[]): StackedPullRequest[] {
  const byHead = new Map<string, PullRequestSummary[]>();
  for (const pr of prs.filter((candidate) => !candidate.isCrossRepository)) byHead.set(pr.headRefName, [...(byHead.get(pr.headRefName) ?? []), pr]);
  // Two of ours from one branch name: no telling which it builds on, so it's on neither.
  const below = (pr: PullRequestSummary) => {
    const parents = byHead.get(pr.baseRefName);
    return parents === undefined || parents.length !== 1 || parents[0] === pr ? null : parents[0]!;
  };
  const above = new Map<number, PullRequestSummary[]>();
  for (const pr of prs) {
    const parent = below(pr);
    if (parent !== null) above.set(parent.number, [...(above.get(parent.number) ?? []), pr]);
  }
  const ordered: StackedPullRequest[] = [];
  const placed = new Set<number>();
  const place = (pr: PullRequestSummary, stackedOn: number | null) => {
    if (placed.has(pr.number)) return;
    placed.add(pr.number);
    ordered.push({ pr, stackedOn });
    for (const next of [...(above.get(pr.number) ?? [])].sort((a, b) => a.number - b.number)) place(next, pr.number);
  };
  for (const pr of prs) if (below(pr) === null) place(pr, null);
  // Only a loop is left: its first listed starts it.
  for (const pr of prs) place(pr, null);
  return ordered;
}
