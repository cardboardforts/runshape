// npm run runshape -- list | record <ref>... [--fetch] [--again] | compare <base> [<head>] [--fetch] [--tip] | forget <id>
// Keeps .runshape/recordings: one recording per commit, plus the working tree's.
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, sep } from "node:path";

import {
  ArchitectureSnapshot,
  buildFolderGuides,
  buildPlacements,
  buildReviewBundle,
  byCodeUnit,
  ChangeContext,
  CommitMessage,
  explainChange,
  Explanation,
  explanationInputs,
  explanationMarkdown,
  folderGuideMarkdown,
  LanguageModel,
  mergeIntoReadme,
  loadLatestRun,
  ReviewBundle,
  Outcome,
  reviewBundleMarkdown,
  RULES_FILE,
  Run,
  ZoneRules,
  ZoneRulesError,
  ZoneSource,
} from "@runshape/core";
import {
  ARCHITECTURE_FILE,
  ArchitectureSummary,
  CommitSummary,
  GitCli,
  GitError,
  INCOMING_PREFIX,
  LibraryOverview,
  METADATA_FILE,
  RecordingLibrary,
  RecordingMetadata,
  recordingIdFor,
  REQUESTED_REVIEWS_FILE,
  SANDBOX_SUFFIX,
  RequestedReview,
  RequestedReviews,
  ReviewHighlights,
  WORKING_TREE_ID,
} from "@runshape/library";
export type { PullRequestSummary } from "@runshape/library";
import type { PullRequestSummary } from "@runshape/library";
import { assertPlainFiles, removeAnyway } from "./docker-recorder";
import type { ModelChoice } from "./models";
import { launchdJob, scheduleInstructions } from "./schedule";

/** What to record: a commit (checked out on its own, the working tree untouched) or the working tree as it is. */
export type RecordTarget = { kind: "commit"; commit: string } | { kind: "working" };

/** Port: records one target's tests into a directory, leaving latest.json and its run there. */
export interface Recorder {
  /** Where it records ("host", "docker:<image>"): recordings made in different places differ for that alone. */
  readonly environment: string;
  record(target: RecordTarget, outDirectory: string): Promise<void>;
}

/** Port: the open pull requests asking for the person's review (gh in pull-requests.ts). */
export interface PullRequests {
  requestingMyReview(limit: number): Promise<PullRequestSummary[]>;
  /** Where they're listed from, to fetch them from: in a fork workflow that's not origin. */
  repository(): Promise<string>;
}

export interface RecordingsDependencies {
  /** The project's root: its git repository, and where .runshape/recordings lives. */
  root: string;
  recorder: Recorder;
  /** Records commits in a container (`--sandbox`), given the recorder's version (docker-recorder.ts). */
  sandbox: (recorderVersion: string) => Recorder;
  print: (line: string) => void;
  now: () => Date;
  /** The language model `--explain` asks: claude -p, the Anthropic API (models.ts), or a fake in tests. */
  models: (choice: ModelChoice) => Promise<LanguageModel>;
  pullRequests: PullRequests;
}

/** Where the demo's dev server serves the recordings page (npm run dev -w packages/webview). */
export const DEMO_URL = "http://localhost:5173/demo/index.html";
const FAILING = new Set<string>([Outcome.Failed, Outcome.Error, Outcome.UnexpectedPass]);
const REMOTE = "origin";

class UsageError extends Error {}

export async function runRecordings(argv: string[], dependencies: RecordingsDependencies): Promise<number> {
  // "--explain=api": a flag's name, and its value if it has one.
  const flagValues = new Map(argv.filter((arg) => arg.startsWith("--")).map((arg) => [arg.split("=")[0]!, arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : null]));
  const flags = new Set(flagValues.keys());
  const [command = "list", ...names] = argv.filter((arg) => !arg.startsWith("--"));
  const unknownFlags = [...flags].filter((flag) => !KNOWN_FLAGS.has(flag));
  const recordings = new Recordings(dependencies, {
    fetch: flags.has("--fetch"),
    again: flags.has("--again"),
    explainAgain: flags.has("--explain-again"),
    // Someone else's code is always recorded in the container.
    sandbox: flags.has("--sandbox") || command === "review-requests",
  });
  const againstTip = flags.has("--tip");
  try {
    if (unknownFlags.length > 0) throw new UsageError(`unknown option ${unknownFlags.join(", ")}\n${USAGE}`);
    if (againstTip && command !== "compare") throw new UsageError("--tip only applies to compare");
    // --explain-again asks the model again without recording again (--again would do both).
    const explainFlag = flags.has("--explain-again") ? "--explain-again" : "--explain";
    const explain = flags.has(explainFlag) ? (flagValues.get(explainFlag) ?? "auto") : null;
    if (explain !== null && command !== "compare" && command !== "review-requests") throw new UsageError("--explain only applies to compare and review-requests");
    if (explain !== null && !MODEL_CHOICES.has(explain)) throw new UsageError("--explain takes claude or api (or nothing: claude -p if it runs, else the API)");
    switch (command) {
      case "list":
        await recordings.list();
        return 0;
      case "record":
        if (names.length === 0) throw new UsageError(`record what? ${USAGE}`);
        if (flags.has("--sandbox") && names.includes(WORKING_TREE_ID)) {
          throw new UsageError("--sandbox records commits: the working tree is yours, recorded on this machine without it");
        }
        await recordings.exclusively(async () => {
          if (names.includes(WORKING_TREE_ID)) await recordings.refuseCheckedOutPullRequest();
          const plans: Plan[] = [];
          for (const name of names) plans.push(await recordings.plan(name, { fetch: true }));
          for (const plan of await recordings.place(plans, { workingHead: false })) await recordings.ensure(plan);
        });
        return 0;
      case "compare": {
        if (names.length < 1 || names.length > 2) throw new UsageError(`compare <base> [<head>]\n${USAGE}`);
        const [baseName, headName = WORKING_TREE_ID] = names as [string, string?];
        // Both sides from one place: the working tree is recorded here, so a sandboxed base wouldn't compare.
        if (flags.has("--sandbox") && (headName === WORKING_TREE_ID || baseName === WORKING_TREE_ID)) {
          throw new UsageError("--sandbox compares commits: name the head (the working tree is yours, recorded on this machine without it)");
        }
        await recordings.exclusively(async () => {
          const compared = await recordings.compare(baseName, headName, { againstTip });
          if (explain !== null) await recordings.explain(compared.review, compared.base, compared.head, explain as ModelChoice);
        });
        return 0;
      }
      case "review-requests": {
        const limit = Number(flagValues.get("--limit") ?? DEFAULT_PULL_REQUEST_LIMIT);
        if (!Number.isInteger(limit) || limit < 1) throw new UsageError("--limit takes a whole number of pull requests");
        const requested = await dependencies.pullRequests.requestingMyReview(limit);
        if (requested.length === 0) {
          dependencies.print("No open pull requests are asking for your review.");
          return 0;
        }
        let failed = 0;
        await recordings.exclusively(async () => {
          failed = await recordings.reviewPullRequests(requested, explain as ModelChoice | null);
        });
        return failed > 0 ? 1 : 0;
      }
      case "readmes":
        await recordings.exclusively(() => recordings.readmes(flags.has("--write")));
        return 0;
      case "schedule": {
        const at = flagValues.get("--at") ?? DEFAULT_SCHEDULE_TIME;
        dependencies.print(launchdJob({ root: dependencies.root, at, path: process.env.PATH ?? "/usr/bin:/bin" }).trimEnd());
        for (const line of scheduleInstructions(dependencies.root)) dependencies.print(line);
        return 0;
      }
      case "forget":
        if (names.length !== 1) throw new UsageError(`forget <id>\n${USAGE}`);
        await recordings.exclusively(() => recordings.forget(names[0]!));
        return 0;
      default:
        throw new UsageError(`unknown command ${command}\n${USAGE}`);
    }
  } catch (error) {
    if (error instanceof UsageError || error instanceof GitError || error instanceof RecordingError) {
      dependencies.print(`runshape: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

const KNOWN_FLAGS = new Set(["--fetch", "--again", "--tip", "--explain", "--explain-again", "--sandbox", "--limit", "--at", "--write"]);
/** Before anyone's at work, after most of a day's pushes. */
const DEFAULT_SCHEDULE_TIME = "03:00";
/** A morning's worth: more than this is a queue to triage, not to record unattended. */
const DEFAULT_PULL_REQUEST_LIMIT = 20;
const MODEL_CHOICES = new Set(["auto", "claude", "api"]);
const USAGE =
  "usage: npm run runshape -- list | record <ref|working>... [--fetch] [--again] [--sandbox] | compare <base> [<head>] [--fetch] [--tip] [--sandbox] [--explain[=claude|api]] | review-requests [--explain] [--limit=N] | readmes [--write] | schedule [--at=HH:MM] | forget <id>";

class RecordingError extends Error {}

/** What a name will record as, worked out before anything is recorded. */
interface Plan {
  id: string;
  /** As the person named it ("main", "origin/main", a hash), for messages. */
  name: string;
  /** How the name reads in messages: "main (ca63db8816d7 Routes: …)". */
  label: string;
  target: RecordTarget;
  summary: CommitSummary;
  tree: { branch: string | null; dirty: boolean };
  /** Set when this is where head's branch left the branch asked for: that branch's newest commit, and how far past it is. */
  forkOf?: { tip: string; commitsSince: number };
}

/** Taken while recording or forgetting, so two runs can't write over each other's recordings. */
const LOCK_FILE = ".lock";
/** The recorder's own source, hashed into each recording: its tests don't change what it records. */
const RECORDER_DIRECTORY = "recorder-ts";
const RECORDER_SOURCE_SKIPPED = new Set(["node_modules", "test"]);

class Recordings {
  private readonly library: RecordingLibrary;
  private readonly git: GitCli;
  private sandboxRecorder: Recorder | null = null;

  constructor(
    private readonly dependencies: RecordingsDependencies,
    private readonly options: { fetch: boolean; again: boolean; explainAgain: boolean; sandbox: boolean },
  ) {
    this.git = new GitCli(dependencies.root);
    this.library = new RecordingLibrary(join(dependencies.root, ".runshape", "recordings"), this.git);
  }

  /** Runs `work` holding the library's lock, taking over a lock whose process is gone. */
  async exclusively(work: () => Promise<void>): Promise<void> {
    await mkdir(this.library.directory, { recursive: true });
    const lock = join(this.library.directory, LOCK_FILE);
    try {
      await writeFile(lock, String(process.pid), { flag: "wx" });
    } catch {
      const holder = Number((await readFile(lock, "utf8").catch(() => "")).trim());
      if (Number.isInteger(holder) && holder > 0 && isRunning(holder)) {
        throw new RecordingError(`another recording is running (process ${holder}); if it isn't, delete ${lock}`);
      }
      await writeFile(lock, String(process.pid));
    }
    try {
      await this.clearInterrupted();
      await work();
    } finally {
      await rm(lock, { force: true });
    }
  }

  /** What `name` names: "working", or a branch, tag or commit (fetched from origin first with --fetch). */
  async plan(name: string, { fetch }: { fetch: boolean }): Promise<Plan> {
    if (name === WORKING_TREE_ID) {
      const working = await this.library.workingTree();
      const summary = await this.library.resolve("HEAD");
      const where = `${working.branch ?? "detached"}${working.dirty ? ", with uncommitted changes" : ""}`;
      return { id: WORKING_TREE_ID, name: "the working tree", label: `the working tree (${where})`, target: { kind: "working" }, summary, tree: { branch: working.branch, dirty: working.dirty } };
    }
    const ref = fetch && this.options.fetch ? await this.fetched(name) : name;
    const summary = await this.library.resolve(ref);
    const shown = ref.replace(/^refs\/remotes\//, "");
    return this.identified({ id: "", name: shown, label: "", target: { kind: "commit", commit: summary.commit }, summary, tree: { branch: null, dirty: false } });
  }

  /**
   * Records what's missing of the two and saves their review; `asked` names the head in the
   * review when its ref isn't how a person would say it (a pull request's).
   */
  async compare(baseName: string, headName: string, options: { againstTip: boolean; headAsked?: string; baseAsked?: string }): Promise<Compared> {
    const workingHead = headName === WORKING_TREE_ID;
    // Either side: a checked-out PR as the base runs here just the same.
    if (workingHead || baseName === WORKING_TREE_ID) await this.refuseCheckedOutPullRequest();
    // --fetch is for the base ("the latest main"): the head is usually yours.
    const plannedHead = await this.plan(headName, { fetch: false });
    const tip = await this.plan(baseName, { fetch: true });
    const fork = options.againstTip ? tip : await this.forkPoint(options.baseAsked ?? baseName, tip, plannedHead);
    // Decided on what was fetched and what will be recorded, not on the names asked for.
    const [base, head] = (await this.place([fork, plannedHead], { workingHead: workingHead || fork.target.kind === "working" })) as [Plan, Plan];
    if (base.id === head.id) throw new RecordingError(`${baseName} and ${options.headAsked ?? headName} are the same recording: nothing to compare`);
    await this.ensure(base, { sameRecorder: true });
    await this.ensure(head, { sameRecorder: true });
    const review = await this.writeReview({ asked: options.baseAsked ?? baseName, plan: base }, { asked: options.headAsked ?? headName, plan: head });
    this.dependencies.print(`review: ${review.markdown}`);
    this.dependencies.print(`open ${DEMO_URL}?base=${base.id}&head=${head.id} (npm run dev -w packages/webview)`);
    return { review, base, head };
  }

  /**
   * Where each planned commit records, decided on the commits themselves, after any fetch.
   * Yours means merged: a commit your default branch holds (main, here or on origin). Anything
   * else (another branch, yours too; a teammate's; a tag; a hash) may be someone else's code,
   * and the whole command records in the sandbox; against the working tree (yours, recorded
   * here) it can't be compared. Returns the plans with their recordings' ids.
   */
  async place(plans: Plan[], { workingHead }: { workingHead: boolean }): Promise<Plan[]> {
    if (!this.options.sandbox) {
      const branch = await this.defaultBranch();
      for (const plan of plans) {
        if (plan.target.kind === "working" || (branch !== null && (await this.onDefaultBranch(plan.summary.commit, branch)))) continue;
        const reason =
          branch === null
            ? `can't be told apart from someone else's code: there's no refs/remotes/${REMOTE}/HEAD to say which branch is merged code. Run \`git remote set-head ${REMOTE} --auto\`, or say which: \`git config ${TRUSTED_BRANCH_CONFIG} main\``
            : `isn't on ${branch} (it may be someone else's code)`;
        if (workingHead) throw new RecordingError(branch === null ? `${plan.name} ${reason}` : `${plan.name} ${reason}: it's recorded in the sandbox, so compare it with a commit, not the working tree`);
        this.dependencies.print(`${plan.name} ${reason}: recording in the sandbox`);
        this.options.sandbox = true;
        break;
      }
    }
    return plans.map((plan) => (plan.target.kind === "working" ? plan : this.identified(plan)));
  }

  /** The plan with the id of its recording where it'll be made: here, or in the sandbox. */
  private identified(plan: Plan): Plan {
    const id = recordingIdFor(plan.summary.commit, this.options.sandbox);
    return { ...plan, id, label: `${plan.name} (${id} ${plan.summary.subject})` };
  }

  /**
   * The working tree is recorded here, as the person's own code. One that's a pull request they
   * checked out (a commit only runshape's PR refs hold, or a branch gh made from a PR) isn't.
   */
  async refuseCheckedOutPullRequest(): Promise<void> {
    const head = (await this.library.resolve("HEAD")).commit;
    const trusted = await this.defaultBranch();
    if (trusted !== null && (await this.onDefaultBranch(head, trusted))) return;
    const prRefs = (await this.git.run(["for-each-ref", "--points-at", head, "--format=%(refname)", PULL_REQUEST_REFS])).trim();
    const branch = (await this.library.workingTree()).branch;
    const merges = branch === null ? "" : (await this.git.run(["config", "--get", `branch.${branch}.merge`]).catch(() => "")).trim();
    if (prRefs === "" && !merges.startsWith("refs/pull/")) return;
    throw new RecordingError(
      `the working tree is a pull request you checked out (${prRefs.split("\n")[0] || merges}): its tests would run here; compare its commit instead, which is recorded in the sandbox`,
    );
  }

  /**
   * The branch of merged code: as the person says (git config runshape.trustedBranch), else as
   * origin says (refs/remotes/origin/HEAD, read in full: a short name can be ambiguous with a
   * branch or tag someone else named). Never guessed: null when neither says.
   */
  private async defaultBranch(): Promise<string | null> {
    const said = (await this.git.run(["config", "--get", TRUSTED_BRANCH_CONFIG]).catch(() => "")).trim();
    if (said !== "") return said;
    const prefix = `refs/remotes/${REMOTE}/`;
    const fromOrigin = (await this.git.run(["symbolic-ref", "--quiet", `${prefix}HEAD`]).catch(() => "")).trim();
    return fromOrigin.startsWith(prefix) ? fromOrigin.slice(prefix.length) : null;
  }

  private async onDefaultBranch(commit: string, branch: string): Promise<boolean> {
    for (const tip of [`refs/heads/${branch}`, `refs/remotes/${REMOTE}/${branch}`]) {
      if (await this.git.run(["merge-base", "--is-ancestor", commit, tip]).then(() => true, () => false)) return true;
    }
    return false;
  }

  /**
   * Each pull request fetched (GitHub's refs/pull/<n>/head, so forks too), recorded in the
   * sandbox and reviewed against where it left its base, explained if asked. One that fails is
   * noted and the rest go on. Writes .runshape/reviews/requested.json for the morning page;
   * returns how many failed.
   */
  async reviewPullRequests(requested: PullRequestSummary[], explain: ModelChoice | null): Promise<number> {
    const entries: RequestedReview[] = [];
    const repository = await this.dependencies.pullRequests.repository();
    for (const pr of requested) {
      const name = `#${pr.number} ${pr.title}`;
      const entry: RequestedReview = { ...pr, head: pr.headRefOid, review: null, explained: false, problem: null, summary: null };
      entries.push(entry);
      try {
        const headRef = `${PULL_REQUEST_REFS}${pr.number}`;
        // Its base as the repository it's listed in has it (in a fork workflow, origin is the fork).
        const baseRef = `refs/runshape/base/${pr.baseRefName}`;
        try {
          await this.git.run(["fetch", "--quiet", "--no-tags", repository, "--end-of-options", `+refs/pull/${pr.number}/head:${headRef}`, `+refs/heads/${pr.baseRefName}:${baseRef}`]);
        } catch (error) {
          throw new RecordingError(`fetching it failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        const compared = await this.compare(baseRef, headRef, { againstTip: false, headAsked: name, baseAsked: pr.baseRefName });
        entry.head = compared.head.summary.commit;
        if (entry.head !== pr.headRefOid) this.dependencies.print(`${name}: its head moved since it was listed; reviewed ${entry.head.slice(0, 7)}`);
        entry.review = basename(compared.review.directory);
        entry.summary = reviewSummary(compared.review.bundle);
        if (explain !== null) {
          try {
            await this.explain(compared.review, compared.base, compared.head, explain);
            entry.explained = true;
          } catch (error) {
            entry.problem = error instanceof Error ? error.message : String(error);
          }
        }
        this.dependencies.print(`${name}: reviewed${entry.explained ? " and explained" : entry.problem ? `; ${entry.problem}` : ""}`);
      } catch (error) {
        // Whatever stopped this one, the rest go on.
        entry.problem = error instanceof Error ? error.message : String(error);
        this.dependencies.print(`${name}: failed: ${entry.problem}`);
      }
      // Written after each, so a run cut short still lists what it got to.
      await this.writeRequested(entries, requested.length);
    }
    return entries.filter((entry) => entry.review === null).length;
  }

  private async writeRequested(entries: RequestedReview[], of: number): Promise<void> {
    const index: RequestedReviews = { format: "runshape-requested-reviews", version: 1, createdAt: this.dependencies.now().toISOString(), pullRequests: entries };
    const reviews = join(this.dependencies.root, ".runshape", "reviews");
    await mkdir(reviews, { recursive: true });
    await writeFile(join(reviews, REQUESTED_REVIEWS_FILE), `${JSON.stringify({ ...index, complete: entries.length === of }, null, 2)}\n`);
  }

  /**
   * Where head's history left the base's: what the branch changed is measured from there. A
   * base that moved on since (main, with others' merges) would otherwise make every one of
   * those merges read as the branch undoing it. The base itself when head contains it, or the
   * two share no history.
   */
  async forkPoint(baseName: string, base: Plan, head: Plan): Promise<Plan> {
    // No fork point is refused, not quietly the tip: CI checks out one commit by default, and
    // the tip there brings back what the fork point is for.
    const fork = (await this.git.run(["merge-base", base.summary.commit, head.summary.commit]).catch(() => "")).trim();
    if (fork === "") {
      throw new RecordingError(
        `can't find where this branch left ${baseName}: they share no history here (in a shallow clone, fetch it: git fetch --unshallow, or fetch-depth: 0 in CI); --tip compares with ${baseName}'s newest commit`,
      );
    }
    if (fork === base.summary.commit) return base;
    if (fork === head.summary.commit && head.id !== WORKING_TREE_ID) {
      throw new RecordingError(`${head.label.split(" (")[0]} is already in ${baseName}: nothing of its own to compare (--tip compares it with ${baseName}'s newest commit)`);
    }
    const ahead = Number((await this.git.run(["rev-list", "--count", `${fork}..${base.summary.commit}`])).trim());
    const summary = await this.library.resolve(fork);
    const id = recordingIdFor(fork);
    this.dependencies.print(
      `${baseName} is ${ahead} commit${ahead === 1 ? "" : "s"} past where this branch left it: comparing with ${id} (${summary.subject}), where it left; --tip compares with ${baseName} itself`,
    );
    return {
      ...this.identified({ id, name: `${baseName}'s fork point`, label: "", target: { kind: "commit", commit: fork }, summary, tree: { branch: null, dirty: false } }),
      forkOf: { tip: base.summary.commit, commitsSince: ahead },
    };
  }

  /**
   * The planned recording, made now if there isn't one. A commit is recorded once; the working
   * tree every time, since it changes under you. With `sameRecorder` (compare), a commit
   * recorded by another version of the recorder is recorded again.
   */
  async ensure(plan: Plan, { sameRecorder = false } = {}): Promise<void> {
    const { print } = this.dependencies;
    let existing = (await this.library.recordings()).recordings.find((r) => r.id === plan.id);
    const recorder = await this.recorderFor(plan.target);
    let madeIn = existing?.environment ?? HOST_ENVIRONMENT;
    // Recorded in the sandbox before its recordings had ids of their own. Here, the commit is
    // known to be yours (place: on the default branch), so it's recorded here; the sandbox's is kept as its own.
    if (existing && madeIn.startsWith("docker:") && recorder.environment === HOST_ENVIRONMENT) {
      await this.keepAsSandboxed(existing.id);
      print(`${plan.label} was recorded in the sandbox before; that's kept as ${existing.id}${SANDBOX_SUFFIX}, and it's recorded here too`);
      existing = undefined;
      madeIn = HOST_ENVIRONMENT;
    }
    if (existing && plan.id !== WORKING_TREE_ID && !this.options.again) {
      if (!sameRecorder || (existing.recorderSource === (await this.recorderSourceFor(recorder)) && madeIn === recorder.environment)) {
        print(`${plan.label} is recorded already; record it again with --again`);
        return;
      }
      if (madeIn !== recorder.environment) print(`${plan.label} was recorded elsewhere (${madeIn}): recording it again in ${recorder.environment}`);
      else print(`${plan.label} was recorded by another version of ${RECORDER_DIRECTORY}: recording it again`);
    } else {
      print(`recording ${plan.label}…`);
    }
    await this.make(plan);
  }

  /**
   * Saves the comparison as a review bundle beside the recordings (.runshape/reviews/<base>..<head>):
   * review.json for tools, review.md to read or post. Returns the Markdown's path, relative to the project.
   */
  async writeReview(base: { asked: string; plan: Plan }, head: { asked: string; plan: Plan }): Promise<SavedReview> {
    const [baseRun, headRun] = await Promise.all([this.runOf(base.plan.id), this.runOf(head.plan.id)]);
    const [baseRules, headRules] = await Promise.all([this.rulesOf(base.plan.id), this.rulesOf(head.plan.id)]);
    const side = ({ asked, plan }: { asked: string; plan: Plan }) => ({
      asked,
      recording: plan.id,
      commit: plan.summary.commit,
      subject: plan.summary.subject,
      dirty: plan.tree.dirty,
      forkOf: plan.forkOf ?? null,
    });
    const bundle = buildReviewBundle({
      base: baseRun,
      head: headRun,
      baseSide: side(base),
      headSide: side(head),
      // Unknown on either side, both use head's (or none): otherwise every base rule reads as removed.
      baseRules: headRules === null ? null : baseRules,
      rules: headRules ?? ZoneRules.none(),
      createdAt: this.dependencies.now().toISOString(),
    });
    const relative = join(".runshape", "reviews", `${base.plan.id}..${head.plan.id}`);
    const directory = join(this.dependencies.root, relative);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, REVIEW_JSON), `${JSON.stringify(bundle, null, 2)}\n`);
    await writeFile(join(directory, REVIEW_MARKDOWN), reviewBundleMarkdown(bundle));
    // An explanation of an older review mustn't sit beside this one looking current.
    const explained = await readFile(join(directory, EXPLANATION_JSON), "utf8").then((text) => JSON.parse(text) as Explanation, () => null);
    if (explained !== null && explained.basedOn.review !== sha256(reviewBundleMarkdown(bundle))) {
      await rm(join(directory, EXPLANATION_JSON), { force: true });
      await rm(join(directory, EXPLANATION_MARKDOWN), { force: true });
    }
    return { bundle, directory, relative, markdown: join(relative, REVIEW_MARKDOWN) };
  }

  /**
   * Asks a language model why the change was made, from the review (names only) and the commit
   * messages between the two sides; saved beside the review, which it doesn't change. Asked
   * again only when the review or the commits changed (or with --again).
   */
  async explain(review: SavedReview, base: Plan, head: Plan, choice: ModelChoice): Promise<void> {
    const where = join(review.relative, EXPLANATION_MARKDOWN);
    try {
      const context: ChangeContext = { commits: await this.commitsBetween(base.summary.commit, head.summary.commit), uncommittedChanges: head.tree.dirty || base.tree.dirty };
      const inputs = explanationInputs(review.bundle, context, sha256);
      const model = await this.dependencies.models(choice);
      const saved = await readFile(join(review.directory, EXPLANATION_JSON), "utf8").then((text) => JSON.parse(text) as Explanation, () => null);
      if (saved !== null && !this.options.explainAgain && saved.model === model.name && JSON.stringify(saved.basedOn) === JSON.stringify(inputs)) {
        this.dependencies.print(`explanation: ${where} (current: same review, commits and model)`);
        return;
      }
      const explanation = await explainChange(model, review.bundle, context, this.dependencies.now().toISOString(), sha256);
      await writeFile(join(review.directory, EXPLANATION_JSON), `${JSON.stringify(explanation, null, 2)}\n`);
      await writeFile(join(review.directory, EXPLANATION_MARKDOWN), explanationMarkdown(explanation));
      this.dependencies.print(`explanation: ${where} (by ${explanation.model})`);
    } catch (error) {
      if (error instanceof UsageError || error instanceof GitError) throw error;
      throw new RecordingError(`explaining failed (the review is saved): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * The commits head has that the base hasn't, oldest first: what the authors said about the
   * change. Records end in NUL (-z), which git doesn't allow in a message, so a message can't
   * forge another commit.
   */
  private async commitsBetween(base: string, head: string): Promise<CommitMessage[]> {
    const output = await this.git.run(["log", "-z", "--reverse", "--format=%H%n%s%n%b", `${base}..${head}`, "--"]);
    return output
      .split("\0")
      .filter((entry) => entry.trim() !== "")
      .map((entry) => {
        const [commit, subject, ...body] = entry.split("\n");
        return { commit: commit!, subject: subject ?? "", body: body.join("\n") };
      });
  }

  private runOf(id: string): Promise<Run> {
    const directory = join(this.library.directory, id);
    return loadLatestRun({ readText: (path) => readFile(join(directory, path), "utf8") });
  }

  /** The rules a kept recording was made with: its runshape.json, none if it had none; null for one made before zones were kept. */
  private async rulesOf(id: string): Promise<ZoneRules | null> {
    const recording = (await this.library.recordings()).recordings.find((r) => r.id === id);
    if (recording?.architecture === undefined) return null;
    const text = await readFile(join(this.library.directory, id, RULES_FILE), "utf8").catch(() => null);
    if (text === null || recording.architecture.problem !== null) return ZoneRules.none();
    try {
      return ZoneRules.parse(text.replace(/^\uFEFF/, ""));
    } catch (error) {
      // A rules format that tightened since the recording: compare without them, and say so.
      if (!(error instanceof ZoneRulesError)) throw error;
      this.dependencies.print(`${RULES_FILE} kept with recording ${id} can't be read, so it's compared without rules: ${error.message}`);
      return ZoneRules.none();
    }
  }

  /** Moves a sandboxed recording under a plain id to its own; if that's taken, the plain one goes. */
  private async keepAsSandboxed(id: string): Promise<void> {
    const from = join(this.library.directory, id);
    // Made before recordings from the sandbox were checked: checked before it's touched.
    await assertPlainFiles(from);
    const to = join(this.library.directory, `${id}${SANDBOX_SUFFIX}`);
    if (await readFile(join(to, METADATA_FILE)).then(() => true, () => false)) await removeAnyway(from);
    else {
      await rename(from, to);
      const metadata = JSON.parse(await readFile(join(to, METADATA_FILE), "utf8")) as RecordingMetadata;
      await writeFile(join(to, METADATA_FILE), `${JSON.stringify({ ...metadata, id: `${id}${SANDBOX_SUFFIX}` }, null, 2)}\n`);
    }
  }

  /**
   * A guide to each source folder the working tree's tests run code in, kept in its README.md
   * between markers (folder-readme.ts): what would change, and the questions each raises.
   * Written only with --write.
   */
  async readmes(write: boolean): Promise<void> {
    await this.refuseCheckedOutPullRequest();
    const [working] = await this.place([await this.plan(WORKING_TREE_ID, { fetch: false })], { workingHead: true });
    await this.ensure(working!);
    const run = await this.runOf(WORKING_TREE_ID);
    const rules = (await this.rulesOf(WORKING_TREE_ID)) ?? ZoneRules.none();
    const snapshot = buildPlacements(run, rules);
    const listed = await this.git.run(["ls-files", "--cached", "--others", "--exclude-standard"]);
    const sources = listed.split("\n").filter((file) => SOURCE_FILE.test(file));
    const context = { commit: working!.summary.commit, style: snapshot.style, rules: snapshot.rules.length };
    let questions = 0;
    let folders = 0;
    for (const guide of buildFolderGuides(run, snapshot, sources, rules)) {
      const directory = join(this.dependencies.root, guide.folder);
      if (!(await stat(directory).then((s) => s.isDirectory(), () => false))) continue;
      const file = join(directory, README_FILE);
      const relative = guide.folder === "" ? README_FILE : `${guide.folder}/${README_FILE}`;
      // Only a plain file inside the project, however the recording names the folder.
      if (!(await insideProject(this.dependencies.root, directory)) || (await lstat(file).then((s) => !s.isFile(), () => false))) {
        this.dependencies.print(`${relative}: skipped: not a plain file inside the project`);
        continue;
      }
      folders += 1;
      const existing = await readFile(file, "utf8").catch(() => null);
      const merged = mergeIntoReadme(existing, folderGuideMarkdown(guide, context), guide.folder);
      if (merged.status === "skipped") {
        this.dependencies.print(`${relative}: skipped: it's someone's own (add <!-- runshape:begin --> and <!-- runshape:end --> to keep a guide in it)`);
      } else {
        if (write && merged.status !== "unchanged") await writeFile(file, merged.text);
        this.dependencies.print(`${relative}: ${write || merged.status === "unchanged" ? merged.status : `would ${merged.status === "created" ? "create" : "update"}`}`);
      }
      for (const question of guide.questions) this.dependencies.print(`  ? ${question}`);
      questions += guide.questions.length;
    }
    this.dependencies.print(`${questions} question${questions === 1 ? "" : "s"} in ${folders} folder${folders === 1 ? "" : "s"}.${write ? "" : " Nothing written: --write writes them."}`);
  }

  async list(): Promise<void> {
    const overview = await this.library.overview();
    for (const line of listing(overview)) this.dependencies.print(line);
  }

  async forget(id: string): Promise<void> {
    const recording = (await this.library.recordings()).recordings.find((r) => r.id === id);
    if (recording === undefined) throw new RecordingError(`no recording ${id}`);
    await rm(join(this.library.directory, recording.id), { recursive: true, force: true });
    // Its reviews compare a recording that's gone: they go with it.
    const reviews = join(this.dependencies.root, ".runshape", "reviews");
    const ofIt = (await readdir(reviews).catch(() => [] as string[])).filter((name) => name.split("..").includes(recording.id));
    for (const name of ofIt) await rm(join(reviews, name), { recursive: true, force: true });
    this.dependencies.print(`forgot ${recording.id} (${recording.subject})${ofIt.length > 0 ? ` and ${ofIt.length} review${ofIt.length === 1 ? "" : "s"} of it` : ""}`);
  }

  /**
   * Fetches the branch from origin and names origin's copy in full: a local branch that
   * happens to be called "origin/main" would win the short name. Local branches stay as they are.
   */
  private async fetched(name: string): Promise<string> {
    const branch = name.startsWith(`${REMOTE}/`) ? name.slice(REMOTE.length + 1) : name;
    this.dependencies.print(`fetching ${branch} from ${REMOTE}…`);
    // No tags: a tag pulled in with a fetch is someone else's word for a commit.
    await this.git.run(["fetch", "--quiet", "--no-tags", REMOTE, "--end-of-options", `refs/heads/${branch}:refs/remotes/${REMOTE}/${branch}`]);
    return `refs/remotes/${REMOTE}/${branch}`;
  }

  /** Half-written recordings an interrupted run left: nothing else writes while the lock is held. */
  private async clearInterrupted(): Promise<void> {
    for (const name of await readdir(this.library.directory)) {
      if (!name.startsWith(INCOMING_PREFIX) && !name.startsWith(REPLACED_PREFIX)) continue;
      // Whatever a sandboxed run left (an unreadable folder, say) mustn't stop this one.
      await removeAnyway(join(this.library.directory, name)).catch((error: Error) => this.dependencies.print(`runshape: couldn't clear ${name}: ${error.message}`));
    }
  }

  /** The recorder's source as it is now: what recorded a recording made now. */
  /** The container for commits with --sandbox (the working tree is always recorded here). */
  private async recorderFor(target: RecordTarget): Promise<Recorder> {
    if (!this.options.sandbox || target.kind === "working") return this.dependencies.recorder;
    this.sandboxRecorder ??= this.dependencies.sandbox(await this.sandboxVersion());
    return this.sandboxRecorder;
  }

  /** What recorded with `recorder`: the working tree's recorder here, HEAD's in the sandbox image. */
  private async recorderSourceFor(recorder: Recorder): Promise<string> {
    return recorder.environment === HOST_ENVIRONMENT ? this.recorderSource() : this.sandboxVersion();
  }

  /** What the sandbox image is built from, as HEAD commits it: the recorder, the lockfile, what's left out. */
  private async sandboxVersion(): Promise<string> {
    const hash = createHash("sha256");
    for (const path of SANDBOX_IMAGE_SOURCES) {
      // A path HEAD doesn't have is part of the version too: absent.
      hash.update(path).update("\0").update(await this.git.run(["rev-parse", `HEAD:${path}`]).catch(() => "absent")).update("\0");
    }
    return hash.digest("hex").slice(0, RECORDER_SOURCE_DIGITS);
  }

  /**
   * The recorder as it is now, and what the sandbox image is built from: its source, and the
   * lockfile its dependencies come from. In code-unit order: the same on every machine.
   */
  private async recorderSource(): Promise<string> {
    const hash = createHash("sha256");
    hash.update(await readFile(join(this.dependencies.root, "package-lock.json")).catch(() => Buffer.alloc(0))).update("\0");
    const directory = join(this.dependencies.root, RECORDER_DIRECTORY);
    const walk = async (relative: string): Promise<void> => {
      const entries = await readdir(join(directory, relative), { withFileTypes: true }).catch(() => []);
      for (const entry of entries.sort((a, b) => byCodeUnit(a.name, b.name))) {
        if (RECORDER_SOURCE_SKIPPED.has(entry.name)) continue;
        const path = join(relative, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile()) hash.update(path).update("\0").update(await readFile(join(directory, path))).update("\0");
      }
    };
    await walk("");
    return hash.digest("hex").slice(0, RECORDER_SOURCE_DIGITS);
  }

  /** Records into a directory of its own, and moves it into place only once it's complete. */
  private async make(plan: Plan): Promise<void> {
    const { id, target, summary, tree } = plan;
    const incoming = join(this.library.directory, `${INCOMING_PREFIX}${id}`);
    await mkdir(incoming, { recursive: true });
    try {
      const recorder = await this.recorderFor(target);
      const recorderSource = await this.recorderSourceFor(recorder);
      const rules = await this.rulesAt(target);
      if (rules.problem !== null) this.dependencies.print(`${RULES_FILE} at ${plan.label} is invalid, so every zone is inferred: ${rules.problem}`);
      await recorder.record(target, incoming);
      const run = await loadLatestRun({ readText: (path) => readFile(join(incoming, path), "utf8") });
      const architecture = await this.keepArchitecture(incoming, run, rules);
      const metadata: RecordingMetadata = {
        id,
        commit: summary.commit,
        subject: summary.subject,
        committedAt: summary.committedAt,
        branch: tree.branch,
        dirty: tree.dirty,
        recordedAt: this.dependencies.now().toISOString(),
        recorder: run.recorderVersion ?? "unknown",
        recorderSource,
        environment: recorder.environment,
        tests: { total: run.scenarios.length, failed: run.scenarios.filter((s) => FAILING.has(s.outcome)).length },
        architecture,
      };
      await writeFile(join(incoming, METADATA_FILE), `${JSON.stringify(metadata, null, 2)}\n`);
      await this.replace(id, incoming);
      this.dependencies.print(`recorded ${id}: ${metadata.tests.total} tests, ${metadata.tests.failed} failed`);
    } catch (error) {
      await removeAnyway(incoming).catch(() => {}); // the next run clears what's left, and says if it can't
      throw new RecordingError(`recording ${plan.label} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The target's own runshape.json: the commit's as committed, the working tree's as on disk. */
  private async rulesAt(target: RecordTarget): Promise<CommittedRules> {
    let text: string | null;
    if (target.kind === "working") {
      try {
        text = await readFile(join(this.dependencies.root, RULES_FILE), "utf8");
      } catch (error) {
        // Only a missing file means "no rules"; one that can't be read is a problem to report.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { text: null, rules: ZoneRules.none(), problem: `it can't be read: ${(error as Error).message}` };
        text = null;
      }
    } else {
      // "<mode> <type> <object>\t<path>": a directory, link or submodule there isn't rules to read.
      const entry = (await this.git.run(["ls-tree", target.commit, "--", RULES_FILE])).trim();
      const [mode, type] = entry.split(/\s+/);
      if (entry !== "" && !REGULAR_FILE_MODES.has(mode!)) return { text: null, rules: ZoneRules.none(), problem: `it is a ${mode === "120000" ? "symbolic link" : type} in the commit, not a file` };
      text = entry === "" ? null : await this.git.run(["show", `${target.commit}:${RULES_FILE}`]);
    }
    if (text === null) return { text: null, rules: ZoneRules.none(), problem: null };
    try {
      // An editor's byte-order mark isn't JSON; VS Code's reader (the extension's) drops it too.
      return { text, rules: ZoneRules.parse(text.replace(/^\uFEFF/, "")), problem: null };
    } catch (error) {
      if (!(error instanceof ZoneRulesError)) throw error;
      return { text, rules: ZoneRules.none(), problem: error.problems.join("; ") };
    }
  }

  /** Writes the rules as they were and where they put each class, for a person to read; returns the summary. */
  private async keepArchitecture(directory: string, run: Run, committed: CommittedRules): Promise<ArchitectureSummary> {
    const snapshot: ArchitectureSnapshot = buildPlacements(run, committed.rules);
    if (committed.text !== null) await writeFile(join(directory, RULES_FILE), committed.text);
    await writeFile(join(directory, ARCHITECTURE_FILE), `${JSON.stringify({ ...snapshot, problem: committed.problem }, null, 2)}\n`);
    const declared = snapshot.placements.filter((p) => p.source === ZoneSource.Rule).length;
    return { style: snapshot.style, rules: snapshot.rules.length, declared, inferred: snapshot.placements.length - declared, problem: committed.problem };
  }

  /** The old recording is set aside, not deleted, until the new one is in place. */
  private async replace(id: string, incoming: string): Promise<void> {
    const final = join(this.library.directory, id);
    const replaced = join(this.library.directory, `${REPLACED_PREFIX}${id}`);
    const hadOne = await rename(final, replaced).then(() => true, () => false);
    try {
      await rename(incoming, final);
    } catch (error) {
      if (hadOne) await rename(replaced, final);
      throw error;
    }
    if (hadOne) await rm(replaced, { recursive: true, force: true });
  }
}

/** A target's runshape.json: its text as committed (null when there's none), and the rules read from it. */
interface CommittedRules {
  text: string | null;
  rules: ZoneRules;
  /** Why the text couldn't be used; the rules are then none, and every zone inferred. */
  problem: string | null;
}

/** A comparison's bundle (docs/review-bundle.md) and its Markdown; a model's explanation of it. */
const REVIEW_JSON = "review.json";
const REVIEW_MARKDOWN = "review.md";
const EXPLANATION_JSON = "explanation.json";
const EXPLANATION_MARKDOWN = "explanation.md";

function reviewSummary(bundle: ReviewBundle): ReviewHighlights {
  return {
    nowFailing: bundle.review.counts["now-failing"],
    silentChanges: bundle.review.counts["silent-change"],
    newTests: bundle.review.counts.added,
    decided: bundle.architecture.decided.length + bundle.architecture.rules.added.length + bundle.architecture.rules.removed.length + bundle.architecture.rules.changed.length,
    needsDecision: bundle.architecture.unplaced.length,
    routesChanged: bundle.routes.routes.length,
  };
}

interface Compared {
  review: SavedReview;
  base: Plan;
  head: Plan;
}

interface SavedReview {
  bundle: ReviewBundle;
  directory: string;
  /** The directory relative to the project, as printed. */
  relative: string;
  markdown: string;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** git's modes for a plain file and an executable one: anything else at runshape.json isn't rules. */
const REGULAR_FILE_MODES = new Set(["100644", "100755"]);

/** Whether a folder, links resolved, is the project or inside it. */
async function insideProject(root: string, directory: string): Promise<boolean> {
  const [project, folder] = await Promise.all([realpath(root), realpath(directory)]);
  return folder === project || folder.startsWith(`${project}${sep}`);
}

/** The files a folder guide lists: source in the languages recorded, tests left out by the guide. */
const SOURCE_FILE = /\.(py|go|[cm]?[jt]sx?)$/;
const README_FILE = "README.md";

/** Where the person names their branch of merged code, when origin's HEAD doesn't. */
const TRUSTED_BRANCH_CONFIG = "runshape.trustedBranch";

/** What the sandbox image is built from: a change to any of them, in HEAD, builds a new one. */
const SANDBOX_IMAGE_SOURCES = ["recorder-ts", "package-lock.json", ".dockerignore"];

/** Where review-requests keeps each PR's head: refs a person wouldn't make, read as someone else's code. */
const PULL_REQUEST_REFS = "refs/runshape/pr/";

/** Where a recording was made when its metadata doesn't say (made before it did). */
const HOST_ENVIRONMENT = "host";

/** A recording being replaced, kept until its replacement is in place. */
const REPLACED_PREFIX = ".replaced-";
/** Enough of the recorder's source hash to tell two versions apart. */
const RECORDER_SOURCE_DIGITS = 16;

/** Whether a process exists: signal 0 checks without sending anything. */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, it's someone else's.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The list command's text: the working tree, what's recorded, what could be. */
function listing(overview: LibraryOverview): string[] {
  const { working, recordings, refs } = overview;
  const workingRecording = recordings.find((r) => r.id === WORKING_TREE_ID);
  const lines = [
    `Working tree: ${working.branch ?? "detached"} at ${working.commit.slice(0, 7)}, ${working.dirty ? "with uncommitted changes" : "no uncommitted changes"} (${
      workingRecording ? `recorded ${when(workingRecording.recordedAt)}` : "not recorded: npm run runshape -- record working"
    })`,
    "",
  ];
  if (recordings.length === 0) {
    lines.push("Nothing recorded yet.");
  } else {
    lines.push(`Recorded (${recordings.length}):`);
    for (const recording of recordings) {
      const names = recording.id === WORKING_TREE_ID ? [`working tree (${recording.branch ?? "detached"})`] : refs.filter((ref) => ref.recordingId === recording.id).map((ref) => ref.name);
      const failed = recording.tests.failed > 0 ? `, ${recording.tests.failed} failed` : "";
      lines.push(`  ${recording.id.padEnd(12)}  ${names.join(", ") || "-"}  ${recording.subject}  ${recording.tests.total} tests${failed}  ${zonesOf(recording.architecture)}  recorded ${when(recording.recordedAt)}`);
    }
  }
  const unrecorded = refs.filter((ref) => ref.recordingId === null);
  if (unrecorded.length > 0) {
    lines.push("", "Not recorded:");
    const names = unrecorded.map((ref) => `${ref.name}${ref.current ? " (checked out)" : ""}`);
    const nameWidth = Math.max(...names.map((name) => name.length));
    const subjectWidth = Math.max(...unrecorded.map((ref) => Math.min(ref.subject.length, MAX_SUBJECT)));
    unrecorded.forEach((ref, i) => {
      lines.push(`  ${names[i]!.padEnd(nameWidth)}  ${truncate(ref.subject).padEnd(subjectWidth)}      npm run runshape -- record ${ref.name}`);
    });
  }
  for (const problem of overview.problems) lines.push(`  (skipped ${problem})`);
  lines.push("", `Compare any two: npm run runshape -- compare <base> [<head>], or browse ${DEMO_URL}`);
  return lines;
}

/** "hexagonal: 2 rules place 5, 4 inferred"; recordings made before zones were kept have none. */
export function zonesOf(architecture: ArchitectureSummary | undefined): string {
  if (architecture === undefined) return "zones not kept";
  if (architecture.problem !== null) return `${RULES_FILE} invalid, ${architecture.inferred} inferred`;
  if (architecture.rules === 0) return `${architecture.style}: no rules, ${architecture.inferred} inferred`;
  return `${architecture.style}: ${architecture.rules} rule${architecture.rules === 1 ? "" : "s"} place ${architecture.declared}, ${architecture.inferred} inferred`;
}

const MAX_SUBJECT = 50;

function truncate(subject: string): string {
  return subject.length > MAX_SUBJECT ? `${subject.slice(0, MAX_SUBJECT - 1)}…` : subject;
}

/** "2026-10-14 12:00", in UTC: recordings are compared by this, not by a local clock. */
function when(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}
