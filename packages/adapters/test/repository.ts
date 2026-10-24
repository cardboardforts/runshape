// A real git repository for each test, and recordings kept in it, shared by the library's,
// the CLI's and the demo dev server's tests.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RecordingMetadata } from "@runshape/kernel";

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

/** A kept recording, as the CLI leaves one: its metadata, a pointer, and an empty run. */
export function recordAt(library: string, metadata: RecordingMetadata): void {
  mkdirSync(join(library, metadata.id, "run"), { recursive: true });
  writeFileSync(join(library, metadata.id, "recording.json"), JSON.stringify(metadata));
  writeFileSync(join(library, metadata.id, "latest.json"), JSON.stringify({ run: "run" }));
  writeFileSync(join(library, metadata.id, "run", "manifest.json"), "{}");
}

/** Metadata for a recording made of one commit; `extra` overrides any of it. */
export function metadata(id: string, commit: string, subject: string, recordedAt: string, extra: Partial<RecordingMetadata> = {}): RecordingMetadata {
  return { id, commit, subject, committedAt: "2026-10-01T10:00:00Z", branch: null, dirty: false, recordedAt, recorder: "recorder-ts", recorderSource: "0123456789abcdef", tests: { total: 3, failed: 0 },
    architecture: { style: "hexagonal", rules: 0, declared: 0, inferred: 3, problem: null }, ...extra };
}
