/**
 * The pre-push hook: `runshape check --gate` runs before a branch leaves for review, and a
 * failing check stops the push (the user's rule: the check is required before human review).
 * Proved with real git pushing to a real bare remote; the check itself is a stand-in script
 * that says what it was asked and exits as told, so this is about the hook, not the check.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { GitCli } from "../src/git/git-cli";
import { installPrePushHook, shellWord } from "../src/git/git-hooks";
import { commitIn, gitIn } from "./repository";

function project() {
  const root = mkdtempSync(join(tmpdir(), "runshape-hook-"));
  const remote = mkdtempSync(join(tmpdir(), "runshape-hook-remote-"));
  execFileSync("git", ["init", "--quiet", "--bare", remote]);
  const git = gitIn(root);
  git("init", "--quiet", "-b", "main");
  commitIn(root, "first");
  git("remote", "add", "origin", remote);
  git("push", "--quiet", "origin", "main");
  git("checkout", "--quiet", "-b", "agent");
  commitIn(root, "the agent's change");
  // The stand-in check: records its arguments, exits with CHECK_EXIT.
  const asked = join(root, "..", `${root.split("/").pop()}-asked.txt`);
  const check = join(root, "..", `${root.split("/").pop()}-check.sh`);
  writeFileSync(check, `#!/bin/sh\necho "$@" > ${shellWord(asked)}\nexit "\${CHECK_EXIT:-0}"\n`, { mode: 0o755 });
  return { root, git, asked, invocation: `${shellWord(check)} --project=${shellWord(root)}` };
}

function push(root: string, ref: string, exit: number) {
  const pushed = spawnSync("git", ["push", "--quiet", "origin", ref], { cwd: root, encoding: "utf8", env: { ...process.env, CHECK_EXIT: String(exit) } });
  return { status: pushed.status, stderr: pushed.stderr.trim().split("\n").filter((line) => line.startsWith("runshape")) };
}

describe("installPrePushHook", () => {
  test("a failing check stops the push, a passing one lets it through, and another branch than the one checked out is refused", async () => {
    const { root, git, asked, invocation } = project();
    const installed = await installPrePushHook(new GitCli(root), root, invocation);
    const failing = push(root, "agent", 1);
    const passing = push(root, "agent", 0);
    git("branch", "other", "main");
    commitIn(root, "more");
    git("branch", "-f", "other", "HEAD~1");
    const otherBranch = push(root, "other", 0);
    expect({
      where: installed.where.slice(root.length),
      replaced: installed.replaced,
      executable: (statSync(installed.where).mode & 0o111) !== 0,
      failing,
      passing,
      asked: readFileSync(asked, "utf8").trim().replace(root, "<root>"),
      otherBranch,
    }).toMatchInlineSnapshot(`
      {
        "asked": "--project=<root> check --gate",
        "executable": true,
        "failing": {
          "status": 1,
          "stderr": [],
        },
        "otherBranch": {
          "status": 1,
          "stderr": [
            "runshape: the check runs on the branch checked out; check out refs/heads/other to push it (or push it with --no-verify, unchecked)",
          ],
        },
        "passing": {
          "status": 0,
          "stderr": [],
        },
        "replaced": false,
        "where": "/.git/hooks/pre-push",
      }
    `);
  });

  test("a hook that isn't Runshape's is never replaced; Runshape's own is", async () => {
    const { root, invocation } = project();
    await installPrePushHook(new GitCli(root), root, invocation);
    const again = await installPrePushHook(new GitCli(root), root, invocation);
    writeFileSync(join(root, ".git", "hooks", "pre-push"), "#!/bin/sh\nmake lint\n");
    const refused = await installPrePushHook(new GitCli(root), root, invocation).catch((error: Error) => error.message.replace(root, "<root>").replace(invocation, "<invocation>"));
    expect({ replaced: again.replaced, refused, kept: readFileSync(join(root, ".git", "hooks", "pre-push"), "utf8") }).toMatchInlineSnapshot(`
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
