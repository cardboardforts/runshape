// The git pre-push hook that runs `runshape check --gate` before a branch leaves this machine
// for review. Installed where git looks for hooks (core.hooksPath, or the common .git/hooks a
// worktree shares); a hook someone else wrote is never replaced.
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { PushGate } from "@runshape/kernel";

import { Git } from "./git-cli";

/** The line that marks a hook as Runshape's: only such a hook is replaced. */
export const RUNSHAPE_HOOK_MARK = "# runshape: pre-push gate";
const EXECUTABLE = 0o755;

/** A hook was already there and isn't Runshape's: said to the person as it is. */
export class HookRefused extends Error {}

/**
 * The hook's text. It gates the branch checked out: a push of another branch is refused,
 * since the check records the working tree (yours, here) rather than a commit (which would
 * record in the sandbox). Deletions and tags push no code to review. `git push --no-verify`
 * skips every hook: the check in CI is what catches that.
 */
export function prePushHook(invocation: string): string {
  return `#!/bin/sh
${RUNSHAPE_HOOK_MARK} (installed by \`runshape check --install-hook\`; remove this file to stop it).
# Runs \`check --gate\` on the branch checked out before it's pushed for review; it fails closed.
# To go past what it finds, the person who'll review is told the findings and says it's fine:
#   ${invocation} check --bypass -- <their words>
head=$(git rev-parse HEAD) || exit 1
while read -r local_ref local_sha remote_ref remote_sha; do
  case "$local_ref" in refs/heads/*) ;; *) continue ;; esac
  case "$local_sha" in *[!0]*) ;; *) continue ;; esac
  if [ "$local_sha" != "$head" ]; then
    echo "runshape: the check runs on the branch checked out; check out $local_ref to push it (or push it with --no-verify, unchecked)" >&2
    exit 1
  fi
done
exec ${invocation} check --gate
`;
}

/** Writes the pre-push hook; says where, and whether it replaced an older Runshape hook. */
export async function installPrePushHook(git: Git, root: string, invocation: string): Promise<{ where: string; replaced: boolean }> {
  const shown = (await git.run(["rev-parse", "--git-path", "hooks"])).trim();
  const hooks = isAbsolute(shown) ? shown : join(root, shown);
  const where = join(hooks, "pre-push");
  const existing = await readFile(where, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing !== null && !existing.includes(RUNSHAPE_HOOK_MARK)) {
    throw new HookRefused(`${where} is already a hook, and not Runshape's: add \`${invocation} check --gate\` to it yourself`);
  }
  await mkdir(hooks, { recursive: true });
  await writeFile(where, prePushHook(invocation), { mode: EXECUTABLE });
  // writeFile's mode applies only to a new file: an older hook keeps its own otherwise.
  await chmod(where, EXECUTABLE);
  return { where, replaced: existing !== null };
}

/** The PushGate port, as git's pre-push hook: someone else's hook is said, not thrown. */
export class GitPushGate implements PushGate {
  constructor(
    private readonly git: Git,
    private readonly root: string,
    private readonly invocation: string,
  ) {}

  async install(): Promise<{ where: string; replaced: boolean } | { refused: string }> {
    try {
      return await installPrePushHook(this.git, this.root, this.invocation);
    } catch (error) {
      if (error instanceof HookRefused) return { refused: error.message };
      throw error;
    }
  }
}

/** A path as one word for sh: single-quoted, any single quote in it closed, escaped and reopened. */
export function shellWord(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}
