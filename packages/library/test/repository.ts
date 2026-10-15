// A real git repository for each test, shared by the library's and the CLI's tests.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const COMMIT_DATE = "2026-10-01T10:00:00Z";

export function gitIn(root: string) {
  return (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, GIT_COMMITTER_DATE: COMMIT_DATE, GIT_AUTHOR_DATE: COMMIT_DATE },
    }).trim();
}

/** Commits a change to file.txt; returns the commit. */
export function commitIn(root: string, subject: string): string {
  const git = gitIn(root);
  writeFileSync(join(root, "file.txt"), subject);
  git("add", "file.txt");
  git("commit", "--quiet", "-m", subject);
  return git("rev-parse", "HEAD");
}

/** main with two commits, origin/main one behind it, and feature checked out one commit ahead. */
export function repository(): { root: string; commits: Record<string, string> } {
  const root = mkdtempSync(join(tmpdir(), "runshape-library-"));
  const git = gitIn(root);
  git("init", "--quiet", "--initial-branch=main");
  // As Runshape's own .gitignore has it: recordings aren't changes to the tree.
  writeFileSync(join(root, ".git", "info", "exclude"), ".runshape/\n");
  const commit = (subject: string) => commitIn(root, subject);
  const first = commit("First");
  git("update-ref", "refs/remotes/origin/main", first);
  // As a clone has it: origin/HEAD names origin's default branch.
  git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  const second = commit("Second");
  git("checkout", "--quiet", "-b", "feature");
  const third = commit("Feature work");
  return { root, commits: { first, second, third } };
}

