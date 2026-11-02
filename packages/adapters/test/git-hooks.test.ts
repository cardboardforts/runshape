/**
 * The pre-push hook: `runshape check --gate` runs on every commit a push sends before it goes
 * for review, and a failing check stops the push (the user's rule: the check is required before
 * human review). Whatever name a commit is pushed by (a branch, another branch, HEAD~1, a raw
 * hash) it's checked; deletions send no code; tags are skipped and said. The hook runs in the
 * worktree it's pushed from, with git's own variables for the hook cleared, so a hook shared by
 * every worktree checks the right one. Proved with real git and a real bare remote; the check
 * is a stand-in that writes what it was asked and exits as told.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { GitCli } from "../src/git/git-cli";
import { GitPushGate, installPrePushHook, shellWord } from "../src/git/git-hooks";
import { commitIn, gitIn } from "./repository";

function project() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "runshape-hook-")));
  const remote = mkdtempSync(join(tmpdir(), "runshape-hook-remote-"));
  execFileSync("git", ["init", "--quiet", "--bare", remote]);
  const git = gitIn(root);
  git("init", "--quiet", "-b", "main");
  commitIn(root, "first");
  git("remote", "add", "origin", remote);
  git("push", "--quiet", "--no-verify", "origin", "main");
  git("checkout", "--quiet", "-b", "agent");
  commitIn(root, "the agent's change");
  commitIn(root, "and another");
  // The stand-in check: appends what it was asked, and whether git's hook variables reached it.
  const asked = join(root, "..", `${root.split("/").pop()}-asked.txt`);
  const check = join(root, "..", `${root.split("/").pop()}-check.sh`);
  writeFileSync(check, `#!/bin/sh\necho "$@ GIT_DIR=\${GIT_DIR-unset}" >> ${shellWord(asked)}\nexit "\${CHECK_EXIT:-0}"\n`, { mode: 0o755 });
  return { root, git, asked, invocation: shellWord(check) };
}

/** Pushes, returning what the check was asked (paths and commits named) and what the push said. */
function push(root: string, asked: string, args: string[], { exit = 0, env = {} }: { exit?: number; env?: Record<string, string> } = {}) {
  writeFileSync(asked, "");
  const pushed = spawnSync("git", ["push", "--quiet", "origin", ...args], { cwd: root, encoding: "utf8", env: { ...process.env, CHECK_EXIT: String(exit), ...env } });
  const git = gitIn(root);
  const named = (line: string) => line.replaceAll(root, "<root>").replace(/[0-9a-f]{40}/g, (sha) => (sha === git("rev-parse", "agent") ? "<agent>" : sha === git("rev-parse", "agent~1") ? "<agent~1>" : sha === git("rev-parse", "main") ? "<main>" : "<other>"));
  return {
    status: pushed.status,
    asked: readFileSync(asked, "utf8").trim().split("\n").filter(Boolean).map(named),
    said: pushed.stderr.trim().split("\n").filter((line) => line.startsWith("runshape")),
  };
}

describe("installPrePushHook", () => {
  test("every commit a push sends is checked, by any name; a failing check stops it; deletions and tags aren't checked", async () => {
    const { root, git, asked, invocation } = project();
    const installed = await installPrePushHook(new GitCli(root), root, invocation);
    git("tag", "v1", "main");
    expect({
      where: installed.where.slice(root.length),
      executable: (statSync(installed.where).mode & 0o111) !== 0,
      failing: push(root, asked, ["agent"], { exit: 1 }),
      branchAndRawHash: push(root, asked, ["agent", `${git("rev-parse", "agent~1")}:refs/heads/earlier`]),
      // Git's own variables for the hook (set here by hand) never reach the check.
      withGitDir: (commitIn(root, "one more"), push(root, asked, ["agent"], { env: { GIT_DIR: join(root, ".git"), GIT_WORK_TREE: root } }).asked),
      deletion: push(root, asked, [":earlier"]),
      tag: push(root, asked, ["v1"]),
    }).toMatchInlineSnapshot(`
      {
        "branchAndRawHash": {
          "asked": [
            "--project=<root> check --gate --head=<agent> GIT_DIR=unset",
            "--project=<root> check --gate --head=<agent~1> GIT_DIR=unset",
          ],
          "said": [],
          "status": 0,
        },
        "deletion": {
          "asked": [],
          "said": [],
          "status": 0,
        },
        "executable": true,
        "failing": {
          "asked": [
            "--project=<root> check --gate --head=<agent> GIT_DIR=unset",
          ],
          "said": [],
          "status": 1,
        },
        "tag": {
          "asked": [],
          "said": [
            "runshape: refs/tags/v1 is a tag: not checked",
          ],
          "status": 0,
        },
        "where": "/.git/hooks/pre-push",
        "withGitDir": [
          "--project=<root> check --gate --head=<agent> GIT_DIR=unset",
        ],
      }
    `);
  });

  test("a hook shared by every worktree checks the worktree it's pushed from", async () => {
    const { root, git, asked, invocation } = project();
    await installPrePushHook(new GitCli(root), root, invocation);
    const worktree = `${root}-worktree`;
    git("worktree", "add", "--quiet", "-b", "elsewhere", worktree, "main");
    commitIn(worktree, "work in the other worktree");
    writeFileSync(asked, "");
    const pushed = spawnSync("git", ["push", "--quiet", "origin", "elsewhere"], { cwd: worktree, encoding: "utf8" });
    expect({ status: pushed.status, project: readFileSync(asked, "utf8").trim().replace(/--head=[0-9a-f]{40}/, "--head=<elsewhere>").replace(worktree, "<worktree>") }).toMatchInlineSnapshot(`
      {
        "project": "--project=<worktree> check --gate --head=<elsewhere> GIT_DIR=unset",
        "status": 0,
      }
    `);
  });

  test("a hook that isn't Runshape's is never replaced, and the gate says so; Runshape's own is replaced", async () => {
    const { root, invocation } = project();
    await installPrePushHook(new GitCli(root), root, invocation);
    const again = await installPrePushHook(new GitCli(root), root, invocation);
    writeFileSync(join(root, ".git", "hooks", "pre-push"), "#!/bin/sh\nmake lint\n");
    const refused = await new GitPushGate(new GitCli(root), root, invocation).install();
    expect({
      replaced: again.replaced,
      refused: "refused" in refused ? refused.refused.replace(root, "<root>").replace(invocation, "<invocation>") : refused,
      kept: readFileSync(join(root, ".git", "hooks", "pre-push"), "utf8"),
    }).toMatchInlineSnapshot(`
      {
        "kept": "#!/bin/sh
      make lint
      ",
        "refused": "<root>/.git/hooks/pre-push is already a hook, and not Runshape's: add \`<invocation> check --gate\` to it yourself",
        "replaced": true,
      }
    `);
  });
});
