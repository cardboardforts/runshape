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
 * The hook's text. It runs `check --gate --head=<commit>` on each distinct commit a push sends,
 * by whatever name it's pushed (a branch, another branch, HEAD~1, a raw hash), in the worktree
 * it runs in. Deletions send no code; tags are skipped and said (a tag names a commit a branch
 * push gates, or a release). `git push --no-verify` skips every hook: CI's check catches that.
 */
export function prePushHook(invocation: string): string {
  return `#!/bin/sh
${RUNSHAPE_HOOK_MARK} (installed by \`runshape check --install-hook\`; remove this file to stop it).
# Runs \`check --gate\` on each commit this push sends, before it goes for review; it fails closed.
# Deletions send nothing and are skipped; tags are skipped, and said.
# To go past what it finds, the person who'll review is told the findings and, at their terminal:
#   ${invocation} --project=<this repository> check --bypass -- <their words>
top=$(git rev-parse --show-toplevel) || exit 1
# The check runs git of its own in $top: git's variables for this hook would point it elsewhere.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_PREFIX GIT_NAMESPACE
commits=""
while read -r local_ref local_sha remote_ref remote_sha; do
  # A deletion: its local commit is all zeros, and it sends no code.
  case "$local_sha" in *[!0]*) ;; *) continue ;; esac
  case "$remote_ref" in refs/tags/*) echo "runshape: $remote_ref is a tag: not checked" >&2; continue ;; esac
  case " $commits " in *" $local_sha "*) ;; *) commits="$commits $local_sha" ;; esac
done
for commit in $commits; do
  ${invocation} --project="$top" check --gate --head="$commit" </dev/null || exit 1
done
exit 0
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
