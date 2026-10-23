import { CommitMessage, CommitSummary, FileAtCommit, GitError, RefSummary, Repository, Uncommitted } from "@runshape/core";

import { Git } from "./git";

/** Where everything is fetched from: the person's own remote. */
const REMOTE = "origin";
/** Where the person names their branch of merged code, when origin's HEAD doesn't. */
const MERGED_BRANCH_SETTING = "runshape.trustedBranch";
/** Where review-requests keeps each PR's head: refs a person wouldn't make, read as someone else's code. */
const PULL_REQUEST_REFS = "refs/runshape/pr/";
/** Where it keeps the base branch of a PR, as the repository the PR is listed in has it. */
const PULL_REQUEST_BASE_REFS = "refs/runshape/base/";
/** git's modes for a plain file and an executable one. */
const REGULAR_FILE_MODES = new Set(["100644", "100755"]);
const SYMBOLIC_LINK_MODE = "120000";

/**
 * What git says about the project, named for what's asked of it. git's command lines, their
 * flags and how its output is read stay here: `--end-of-options` wherever a name could be
 * spelled like an option, -z wherever text from someone else could fake a separator.
 */
export class GitRepository implements Repository {
  readonly remote = REMOTE;
  readonly mergedBranchSetting = MERGED_BRANCH_SETTING;

  constructor(private readonly git: Git) {}

  /** The commit a branch, tag or hash names; GitError when git doesn't know it. */
  async resolve(ref: string): Promise<CommitSummary> {
    let output: string;
    try {
      // --end-of-options: a ref spelled like an option is still a ref.
      output = await this.git.run(["log", "-1", `--format=%H%x00%s%x00%cI`, "--end-of-options", `${ref}^{commit}`, "--"]);
    } catch (error) {
      if (error instanceof GitError) throw new GitError(`git doesn't know ${ref}`);
      throw error;
    }
    const [commit, subject, committedAt] = output.trim().split("\0");
    return { commit: commit!, subject: subject!, committedAt: utc(committedAt!) };
  }

  async workingTree(): Promise<{ branch: string | null; commit: string; dirty: boolean }> {
    const [branch, commit, status] = await Promise.all([
      this.git.run(["symbolic-ref", "--quiet", "--short", "HEAD"]).then((name) => name.trim(), () => null),
      this.git.run(["rev-parse", "HEAD"]),
      // Untracked files count: a new test file not added yet still runs.
      this.git.run(["status", "--porcelain"]),
    ]);
    return { branch, commit: commit.trim(), dirty: status.trim() !== "" };
  }

  /** Every local and remote branch's tip (origin/HEAD left out: it only points at another). */
  async branchTips(): Promise<Omit<RefSummary, "current" | "recordingId">[]> {
    const output = await this.git.run(["for-each-ref", "--format=%(refname)%00%(objectname)%00%(subject)%00%(committerdate:iso-strict)", "refs/heads", "refs/remotes"]);
    const refs: Omit<RefSummary, "current" | "recordingId">[] = [];
    for (const line of output.split("\n")) {
      if (line === "") continue;
      const [refname, commit, subject, committedAt] = line.split("\0");
      if (refname!.endsWith("/HEAD")) continue;
      const kind = refname!.startsWith("refs/heads/") ? "branch" : "remote";
      refs.push({ name: refname!.replace(/^refs\/(heads|remotes)\//, ""), kind, commit: commit!, subject: subject!, committedAt: utc(committedAt!) });
    }
    return refs;
  }

  /**
   * Fetches origin's branch and names origin's copy in full: a local branch that happens to be
   * called "origin/main" would win the short name. Local branches stay as they are.
   */
  async fetchBranch(branch: string): Promise<string> {
    // No tags: a tag pulled in with a fetch is someone else's word for a commit.
    await this.git.run(["fetch", "--quiet", "--no-tags", REMOTE, "--end-of-options", `refs/heads/${branch}:refs/remotes/${REMOTE}/${branch}`]);
    return `refs/remotes/${REMOTE}/${branch}`;
  }

  /**
   * A pull request's head (GitHub's refs/pull/<n>/head, so forks too) and its base branch as
   * the repository it's listed in has it (in a fork workflow, origin is the fork), into refs a
   * person wouldn't make.
   */
  async fetchPullRequest(repository: string, number: number, baseBranch: string): Promise<{ head: string; base: string }> {
    const head = `${PULL_REQUEST_REFS}${number}`;
    const base = `${PULL_REQUEST_BASE_REFS}${baseBranch}`;
    await this.git.run(["fetch", "--quiet", "--no-tags", repository, "--end-of-options", `+refs/pull/${number}/head:${head}`, `+refs/heads/${baseBranch}:${base}`]);
    return { head, base };
  }

  /**
   * The branch of merged code: as the person says (git config runshape.trustedBranch), else as
   * origin says (refs/remotes/origin/HEAD, read in full: a short name can be ambiguous with a
   * branch or tag someone else named). Never guessed: null when neither says.
   */
  async mergedBranch(): Promise<string | null> {
    const said = (await this.git.run(["config", "--get", MERGED_BRANCH_SETTING]).catch(() => "")).trim();
    if (said !== "") return said;
    const prefix = `refs/remotes/${REMOTE}/`;
    const fromOrigin = (await this.git.run(["symbolic-ref", "--quiet", `${prefix}HEAD`]).catch(() => "")).trim();
    return fromOrigin.startsWith(prefix) ? fromOrigin.slice(prefix.length) : null;
  }

  /** Whether the branch holds the commit, here or on origin. */
  async branchContains(branch: string, commit: string): Promise<boolean> {
    for (const tip of [`refs/heads/${branch}`, `refs/remotes/${REMOTE}/${branch}`]) {
      if (await this.git.run(["merge-base", "--is-ancestor", commit, tip]).then(() => true, () => false)) return true;
    }
    return false;
  }

  /** The pull request a commit or branch was checked out from, as git knows it: a PR ref at the commit, or the branch's upstream; null for neither. */
  async pullRequestAt(commit: string, branch: string | null): Promise<string | null> {
    const prRefs = (await this.git.run(["for-each-ref", "--points-at", commit, "--format=%(refname)", PULL_REQUEST_REFS])).trim();
    if (prRefs !== "") return prRefs.split("\n")[0]!;
    const merges = branch === null ? "" : (await this.git.run(["config", "--get", `branch.${branch}.merge`]).catch(() => "")).trim();
    return merges.startsWith("refs/pull/") ? merges : null;
  }

  /** Where two commits' histories meet; null when they share none. */
  async forkPoint(a: string, b: string): Promise<string | null> {
    const fork = (await this.git.run(["merge-base", a, b]).catch(() => "")).trim();
    return fork === "" ? null : fork;
  }

  /** How many commits `to` has that `from` hasn't. */
  async commitsAhead(from: string, to: string): Promise<number> {
    return Number((await this.git.run(["rev-list", "--count", `${from}..${to}`])).trim());
  }

  /**
   * The commits head has that the base hasn't, oldest first. Records end in NUL (-z), which
   * git doesn't allow in a message, so a message can't forge another commit.
   */
  async commitsBetween(base: string, head: string): Promise<CommitMessage[]> {
    const output = await this.git.run(["log", "-z", "--reverse", "--format=%H%n%s%n%b", `${base}..${head}`, "--"]);
    return output
      .split("\0")
      .filter((entry) => entry.trim() !== "")
      .map((entry) => {
        const [commit, subject, ...body] = entry.split("\n");
        return { commit: commit!, subject: subject ?? "", body: body.join("\n") };
      });
  }

  /** Every file in the working tree git doesn't ignore: tracked (deleted ones too) and untracked. */
  async files(): Promise<string[]> {
    return (await this.git.run(["ls-files", "--cached", "--others", "--exclude-standard"])).split("\n").filter((file) => file !== "");
  }

  /** HEAD, every change to it (staged, unstaged) and the untracked files, Markdown left out. */
  async uncommitted(): Promise<Uncommitted> {
    const head = (await this.git.run(["rev-parse", "HEAD"])).trim();
    const diff = await this.git.run(["diff", "--binary", "HEAD", "--", ".", ":(exclude)*.md"]);
    const untracked = (await this.git.run(["ls-files", "--others", "--exclude-standard"])).split("\n").filter((file) => file !== "" && !file.endsWith(".md"));
    return { head, diff, untracked };
  }

  /** The object a path names in HEAD; null when HEAD hasn't got it. */
  async objectAtHead(path: string): Promise<string | null> {
    return this.git.run(["rev-parse", `HEAD:${path}`]).then((id) => id.trim(), () => null);
  }

  /** A path as the commit has it ("<mode> <type> <object>\t<path>" from ls-tree, then its text). */
  async fileAt(commit: string, path: string): Promise<FileAtCommit> {
    const entry = (await this.git.run(["ls-tree", commit, "--", path])).trim();
    if (entry === "") return { kind: "none" };
    const [mode, type] = entry.split(/\s+/);
    if (!REGULAR_FILE_MODES.has(mode!)) return { kind: "other", what: mode === SYMBOLIC_LINK_MODE ? "symbolic link" : type! };
    return { kind: "file", text: await this.git.run(["show", `${commit}:${path}`]) };
  }
}

function utc(date: string): string {
  return new Date(date).toISOString().replace(".000Z", "Z");
}
