/**
 * What git says about a project, as the recordings workflow asks it (GitRepository). Each
 * answer is git's, read from a real repository made for the test: main with two commits,
 * origin/main one behind it, and feature checked out one commit ahead.
 */
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { GitCli, GitRepository } from "../src";
import { commitIn, gitIn, repository } from "./repository";

describe("GitRepository", () => {
  test("a ref resolves to its commit; a name git doesn't know is an error that says so", async () => {
    const { root, commits } = repository();
    const git = new GitRepository(new GitCli(root));

    expect(await git.resolve("origin/main")).toEqual({ commit: commits.first, subject: "First", committedAt: "2026-10-01T10:00:00Z" });
    await expect(git.resolve("nope")).rejects.toThrowError("git doesn't know nope");
    // Passed as one argument, never through a shell, and never taken for an option.
    await expect(git.resolve("--output=/tmp/x")).rejects.toThrowError("git doesn't know --output=/tmp/x");
  });

  test("history: which branch is merged code, what it holds, where two commits meet, and what was said between them", async () => {
    const { root, commits } = repository();
    const git = new GitRepository(new GitCli(root));
    gitIn(root)("config", "runshape.trustedBranch", "feature");

    expect({
      merged: await git.mergedBranch(), // the person's word wins over origin's HEAD
      mainHoldsSecond: await git.branchContains("main", commits.second!),
      mainHoldsFeature: await git.branchContains("main", commits.third!),
      fork: await git.forkPoint(commits.third!, commits.first!),
      ahead: await git.commitsAhead(commits.first!, commits.third!),
      between: (await git.commitsBetween(commits.first!, commits.third!)).map((c) => `${c.commit === commits.second ? "second" : "third"}: ${c.subject}`),
      checkedOutPr: await git.pullRequestAt(commits.third!, "feature"),
    }).toEqual({
      merged: "feature",
      mainHoldsSecond: true,
      mainHoldsFeature: false,
      fork: commits.first,
      ahead: 2,
      between: ["second: Second", "third: Feature work"],
      checkedOutPr: null,
    });
  });

  test("a checked-out pull request is known by a PR ref at its commit, or a branch whose upstream is a PR; anything else isn't one", async () => {
    const { root, commits } = repository();
    const run = gitIn(root);
    const git = new GitRepository(new GitCli(root));
    run("update-ref", "refs/runshape/pr/7", commits.second!);
    run("config", "branch.from-pr.merge", "refs/pull/12/head");
    run("config", "branch.ordinary.merge", "refs/heads/main");

    expect({
      prRefAtCommit: await git.pullRequestAt(commits.second!, "ordinary"),
      upstreamIsPr: await git.pullRequestAt(commits.third!, "from-pr"),
      upstreamIsBranch: await git.pullRequestAt(commits.third!, "ordinary"),
      detached: await git.pullRequestAt(commits.third!, null),
    }).toEqual({ prRefAtCommit: "refs/runshape/pr/7", upstreamIsPr: "refs/pull/12/head", upstreamIsBranch: null, detached: null });
  });

  test("the working tree: its files, what's uncommitted (Markdown left out), and a file as a commit has it", async () => {
    const { root, commits } = repository();
    const run = gitIn(root);
    writeFileSync(join(root, "runshape.json"), '{"version": 2}');
    mkdirSync(join(root, "rules-dir"));
    writeFileSync(join(root, "rules-dir", "x"), "");
    symlinkSync("runshape.json", join(root, "linked.json"));
    run("add", ".");
    const withFiles = commitIn(root, "Rules");
    writeFileSync(join(root, "file.txt"), "changed, not committed");
    writeFileSync(join(root, "new.ts"), "export {};");
    writeFileSync(join(root, "notes.md"), "not code");
    const git = new GitRepository(new GitCli(root));

    const uncommitted = await git.uncommitted();

    expect({
      files: (await git.files()).sort(),
      head: uncommitted.head,
      diffTouches: uncommitted.diff.includes("file.txt"),
      untracked: uncommitted.untracked,
      rules: await git.fileAt(withFiles, "runshape.json"),
      folder: await git.fileAt(withFiles, "rules-dir"),
      link: await git.fileAt(withFiles, "linked.json"),
      none: await git.fileAt(commits.first!, "runshape.json"),
      objectAtHead: (await git.objectAtHead("file.txt"))?.length,
      notAtHead: await git.objectAtHead("nothing-here"),
    }).toEqual({
      files: ["file.txt", "linked.json", "new.ts", "notes.md", "rules-dir/x", "runshape.json"],
      head: withFiles,
      diffTouches: true,
      untracked: ["new.ts"],
      rules: { kind: "file", text: '{"version": 2}' },
      folder: { kind: "other", what: "tree" },
      link: { kind: "other", what: "symbolic link" },
      none: { kind: "none" },
      objectAtHead: 40,
      notAtHead: null,
    });
  });

  test("changed lines between two commits, or a commit and the working tree: added and removed per file, no context, no binaries", async () => {
    // The story reads docs and comments from these: a line that looks like a diff header
    // ("--- a/x", "diff --git") inside a file is still that file's line.
    const { root, commits } = repository();
    const run = gitIn(root);
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs", "why.md"), "# Why\n\nOld reason.\n");
    writeFileSync(join(root, "gone.py"), "x = 1\n");
    writeFileSync(join(root, "image.bin"), Buffer.from([0, 1, 2, 0]));
    run("add", ".");
    const before = commitIn(root, "Docs");
    writeFileSync(join(root, "docs", "why.md"), "# Why\n\nNew reason.\n--- a/fake\ndiff --git a/x b/x\n");
    writeFileSync(join(root, "a file.ts"), "// spaces in its name\n");
    writeFileSync(join(root, "image.bin"), Buffer.from([0, 3, 2, 0]));
    run("rm", "--quiet", "gone.py");
    run("add", ".");
    run("commit", "--quiet", "-m", "Rewrite");
    const after = run("rev-parse", "HEAD");
    writeFileSync(join(root, "docs", "why.md"), "# Why not\n");
    const git = new GitRepository(new GitCli(root));

    expect({ committed: await git.changedLines(before, after), working: await git.changedLines(after, null), none: await git.changedLines(commits.third!, commits.third!) }).toEqual({
      committed: [
        { path: "a file.ts", added: ["// spaces in its name"], removed: [] },
        { path: "docs/why.md", added: ["New reason.", "--- a/fake", "diff --git a/x b/x"], removed: ["Old reason."] },
        { path: "gone.py", added: [], removed: ["x = 1"] },
      ],
      working: [{ path: "docs/why.md", added: ["# Why not"], removed: ["# Why", "", "New reason.", "--- a/fake", "diff --git a/x b/x"] }],
      none: [],
    });
  });
});
