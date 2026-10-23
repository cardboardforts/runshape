// npm run runshape -- list | record <ref>... [--fetch] [--again] | compare <base> [<head>] [--fetch] [--tip] | forget <id>
// Keeps .runshape/recordings: one recording per commit, plus the working tree's.
import {
  ArchitectureSnapshot,
  buildFolderGuides,
  buildPlacements,
  buildReviewBundle,
  byCodeUnit,
  ChangeContext,
  describeFolder,
  describeReadme,
  explainChange,
  Explanation,
  explanationInputs,
  explanationMarkdown,
  FolderGuide,
  folderGuideMarkdown,
  LanguageModel,
  mergeIntoReadme,
  needsDescription,
  openingComment,
  Outcome,
  ReviewBundle,
  reviewBundleMarkdown,
  RULES_FILE,
  Run,
  TraceDirectory,
  ZoneRules,
  ZoneRulesError,
  ZoneSource,
} from "@runshape/core";
import {
  ArchitectureSummary,
  CommitSummary,
  EXPLANATION_MARKDOWN,
  GitError,
  IncomingRecording,
  LibraryOverview,
  RecordingLibrary,
  RecordingMetadata,
  recordingIdFor,
  REVIEW_MARKDOWN,
  reviewName,
  SANDBOX_SUFFIX,
  RequestedReview,
  RequestedReviews,
  ReviewHighlights,
  WORKING_TREE_ID,
} from "@runshape/library";
import { LockHeld } from "@runshape/infra";
import type { PullRequestSummary } from "@runshape/library";
import { assertPlainRecording } from "./docker-recorder";
import { Hashing, ProjectFiles, PullRequests, Recorder, RecordTarget, Repository, VERSION_DIGITS } from "./ports";
import type { ModelChoice } from "./models";
import { launchdJob, scheduleInstructions } from "./schedule";

export interface RecordingsDependencies {
  /** The project's root: its git repository. */
  root: string;
  repository: Repository;
  /** The project's own working tree: folder guides' READMEs, the working tree's runshape.json. */
  project: ProjectFiles;
  hashing: Hashing;
  /** Its recordings and reviews (projectLibrary: .runshape/recordings and .runshape/reviews). */
  library: RecordingLibrary;
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
    const describe = flags.has("--describe") ? (flagValues.get("--describe") ?? "auto") : null;
    if (describe !== null && command !== "readmes") throw new UsageError("--describe only applies to readmes");
    if (describe !== null && !MODEL_CHOICES.has(describe)) throw new UsageError("--describe takes claude or api (or nothing: claude -p if it runs, else the API)");
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
      case "readmes": {
        let failed = 0;
        await recordings.exclusively(async () => {
          failed = await recordings.readmes(flags.has("--write"), describe as ModelChoice | null);
        });
        return failed > 0 ? 1 : 0;
      }
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

const KNOWN_FLAGS = new Set(["--fetch", "--again", "--tip", "--explain", "--explain-again", "--sandbox", "--limit", "--at", "--write", "--describe"]);
/** Before anyone's at work, after most of a day's pushes. */
const DEFAULT_SCHEDULE_TIME = "03:00";
/** A morning's worth: more than this is a queue to triage, not to record unattended. */
const DEFAULT_PULL_REQUEST_LIMIT = 20;
const MODEL_CHOICES = new Set(["auto", "claude", "api"]);
const USAGE =
  "usage: npm run runshape -- list | record <ref|working>... [--fetch] [--again] [--sandbox] | compare <base> [<head>] [--fetch] [--tip] [--sandbox] [--explain[=claude|api]] | review-requests [--explain] [--limit=N] | readmes [--write] [--describe[=claude|api]] | schedule [--at=HH:MM] | forget <id>";

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

class Recordings {
  private readonly library: RecordingLibrary;
  private readonly repository: Repository;
  private sandboxRecorder: Recorder | null = null;

  constructor(
    private readonly dependencies: RecordingsDependencies,
    private readonly options: { fetch: boolean; again: boolean; explainAgain: boolean; sandbox: boolean },
  ) {
    this.repository = dependencies.repository;
    this.library = dependencies.library;
  }

  /** Runs `work` holding the library's lock, taking over a lock whose process is gone. */
  async exclusively(work: () => Promise<void>): Promise<void> {
    try {
      await this.library.store.exclusively(work, (name, error) => this.dependencies.print(`runshape: couldn't clear ${name}: ${error.message}`));
    } catch (error) {
      if (error instanceof LockHeld) throw new RecordingError(`another recording is running (process ${error.holder}); if it isn't, delete ${error.lockFile}`);
      throw error;
    }
  }

  /** What `name` names: "working", or a branch, tag or commit (fetched from origin first with --fetch). */
  async plan(name: string, { fetch }: { fetch: boolean }): Promise<Plan> {
    if (name === WORKING_TREE_ID) {
      const working = await this.repository.workingTree();
      const summary = await this.repository.resolve("HEAD");
      const where = `${working.branch ?? "detached"}${working.dirty ? ", with uncommitted changes" : ""}`;
      return { id: WORKING_TREE_ID, name: "the working tree", label: `the working tree (${where})`, target: { kind: "working" }, summary, tree: { branch: working.branch, dirty: working.dirty } };
    }
    const ref = fetch && this.options.fetch ? await this.fetched(name) : name;
    const summary = await this.repository.resolve(ref);
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
      const branch = await this.repository.mergedBranch();
      const { remote, mergedBranchSetting } = this.repository;
      for (const plan of plans) {
        if (plan.target.kind === "working" || (branch !== null && (await this.repository.branchContains(branch, plan.summary.commit)))) continue;
        const reason =
          branch === null
            ? `can't be told apart from someone else's code: there's no refs/remotes/${remote}/HEAD to say which branch is merged code. Run \`git remote set-head ${remote} --auto\`, or say which: \`git config ${mergedBranchSetting} main\``
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
    const head = (await this.repository.resolve("HEAD")).commit;
    const trusted = await this.repository.mergedBranch();
    if (trusted !== null && (await this.repository.branchContains(trusted, head))) return;
    const pullRequest = await this.repository.pullRequestAt(head, (await this.repository.workingTree()).branch);
    if (pullRequest === null) return;
    throw new RecordingError(
      `the working tree is a pull request you checked out (${pullRequest}): its tests would run here; compare its commit instead, which is recorded in the sandbox`,
    );
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
        let fetched: { head: string; base: string };
        try {
          fetched = await this.repository.fetchPullRequest(repository, pr.number, pr.baseRefName);
        } catch (error) {
          throw new RecordingError(`fetching it failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        const { head: headRef, base: baseRef } = fetched;
        const compared = await this.compare(baseRef, headRef, { againstTip: false, headAsked: name, baseAsked: pr.baseRefName });
        entry.head = compared.head.summary.commit;
        if (entry.head !== pr.headRefOid) this.dependencies.print(`${name}: its head moved since it was listed; reviewed ${entry.head.slice(0, 7)}`);
        entry.review = compared.review.name;
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
    await this.library.reviews.saveRequested(index, entries.length === of);
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
    const fork = await this.repository.forkPoint(base.summary.commit, head.summary.commit);
    if (fork === null) {
      throw new RecordingError(
        `can't find where this branch left ${baseName}: they share no history here (in a shallow clone, fetch it: git fetch --unshallow, or fetch-depth: 0 in CI); --tip compares with ${baseName}'s newest commit`,
      );
    }
    if (fork === base.summary.commit) return base;
    if (fork === head.summary.commit && head.id !== WORKING_TREE_ID) {
      throw new RecordingError(`${head.label.split(" (")[0]} is already in ${baseName}: nothing of its own to compare (--tip compares it with ${baseName}'s newest commit)`);
    }
    const ahead = await this.repository.commitsAhead(fork, base.summary.commit);
    const summary = await this.repository.resolve(fork);
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
    let existing = await this.library.store.recording(plan.id);
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
      if (!sameRecorder || (existing.recorderSource === (await recorder.source()) && madeIn === recorder.environment)) {
        print(`${plan.label} is recorded already; record it again with --again`);
        return;
      }
      if (madeIn !== recorder.environment) print(`${plan.label} was recorded elsewhere (${madeIn}): recording it again in ${recorder.environment}`);
      else print(`${plan.label} was recorded by another version of its recorder: recording it again`);
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
    const reviews = this.library.reviews;
    const name = reviewName(base.plan.id, head.plan.id);
    await reviews.saveReview(name, bundle, reviewBundleMarkdown(bundle));
    // An explanation of an older review mustn't sit beside this one looking current.
    const explained = (await reviews.explanation(name)) as Explanation | null;
    if (explained !== null && explained.basedOn.review !== this.dependencies.hashing.sha256(reviewBundleMarkdown(bundle))) await reviews.dropExplanation(name);
    return { bundle, name, markdown: reviews.shownPath(name, REVIEW_MARKDOWN) };
  }

  /**
   * Asks a language model why the change was made, from the review (names only) and the commit
   * messages between the two sides; saved beside the review, which it doesn't change. Asked
   * again only when the review or the commits changed (or with --again).
   */
  async explain(review: SavedReview, base: Plan, head: Plan, choice: ModelChoice): Promise<void> {
    const where = this.library.reviews.shownPath(review.name, EXPLANATION_MARKDOWN);
    const { sha256 } = this.dependencies.hashing;
    try {
      const context: ChangeContext = { commits: await this.repository.commitsBetween(base.summary.commit, head.summary.commit), uncommittedChanges: head.tree.dirty || base.tree.dirty };
      const inputs = explanationInputs(review.bundle, context, sha256);
      const model = await this.dependencies.models(choice);
      const saved = (await this.library.reviews.explanation(review.name)) as Explanation | null;
      if (saved !== null && !this.options.explainAgain && saved.model === model.name && JSON.stringify(saved.basedOn) === JSON.stringify(inputs)) {
        this.dependencies.print(`explanation: ${where} (current: same review, commits and model)`);
        return;
      }
      const explanation = await explainChange(model, review.bundle, context, this.dependencies.now().toISOString(), sha256);
      await this.library.reviews.saveExplanation(review.name, explanation, explanationMarkdown(explanation));
      this.dependencies.print(`explanation: ${where} (by ${explanation.model})`);
    } catch (error) {
      if (error instanceof UsageError || error instanceof GitError) throw error;
      throw new RecordingError(`explaining failed (the review is saved): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private runOf(id: string): Promise<Run> {
    return new TraceDirectory(this.library.store.filesOf(id)).latest();
  }

  /** The rules a kept recording was made with: its runshape.json, none if it had none; null for one made before zones were kept. */
  private async rulesOf(id: string): Promise<ZoneRules | null> {
    const recording = await this.library.store.recording(id);
    if (recording?.architecture === undefined) return null;
    const text = await this.library.store.keptRules(id);
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
    // Made before recordings from the sandbox were checked: checked before it's touched.
    await assertPlainRecording(this.library.store.pathOf(id));
    await this.library.store.move(id, `${id}${SANDBOX_SUFFIX}`);
  }

  /**
   * A guide to each source folder the working tree's tests run code in, kept in its README.md
   * between markers (folder-readme.ts): what would change, and the questions each raises.
   * Written only with --write. With --describe, a model's draft of what the folder is for goes
   * where a person's words would, in READMEs that don't have them yet. How many drafts failed.
   */
  async readmes(write: boolean, describe: ModelChoice | null): Promise<number> {
    await this.refuseCheckedOutPullRequest();
    const [working] = await this.place([await this.plan(WORKING_TREE_ID, { fetch: false })], { workingHead: true });
    // Preview, then --write: the second run writes what the first showed, from the same recording.
    const kept = await this.library.store.recording(WORKING_TREE_ID);
    const unchanged = kept?.tree !== undefined && kept.tree === (await this.treeFingerprint()) && kept.recorderSource === (await this.dependencies.recorder.source());
    if (unchanged) this.dependencies.print(`the working tree hasn't changed since it was recorded (${kept!.recordedAt}): using that recording`);
    else await this.ensure(working!);
    const run = await this.runOf(WORKING_TREE_ID);
    const rules = (await this.rulesOf(WORKING_TREE_ID)) ?? ZoneRules.none();
    const snapshot = buildPlacements(run, rules);
    // Tracked files deleted from the tree are listed too; declaration files never run.
    const sources: string[] = [];
    for (const file of await this.repository.files()) {
      if (SOURCE_FILE.test(file) && !DECLARATION_FILE.test(file) && (await this.dependencies.project.isPlainFile(file))) sources.push(file);
    }
    const context = { style: snapshot.style, rules: snapshot.rules.length };
    // Chosen when a README first needs it (choosing runs `claude --version` or needs a key); a
    // choice that fails is every draft's failure, and the guides are still written.
    let model: Promise<LanguageModel | Error> | null = null;
    const describer = () => (model ??= this.dependencies.models(describe!).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error)))));
    let failed = 0;
    let questions = 0;
    let folders = 0;
    for (const guide of buildFolderGuides(run, snapshot, sources, rules)) {
      const readme = await this.dependencies.project.readme(guide.folder);
      if (readme.kind === "no-folder") continue;
      const relative = guide.folder === "" ? README_FILE : `${guide.folder}/${README_FILE}`;
      if (readme.kind === "not-plain") {
        this.dependencies.print(`${relative}: skipped: not a plain file inside the project`);
        continue;
      }
      folders += 1;
      if (readme.kind === "unreadable") {
        this.dependencies.print(`${relative}: skipped: it can't be read (${readme.reason})`);
        continue;
      }
      const existing = readme.text;
      const merged = mergeIntoReadme(existing, folderGuideMarkdown(guide, context), guide.folder);
      if (merged.status === "skipped") {
        this.dependencies.print(`${relative}: skipped: it's someone's own, or its runshape markers aren't one pair of lines (to keep a guide in it, add a line <!-- runshape:begin --> and a line <!-- runshape:end -->)`);
      } else {
        let text = merged.text;
        let note: string | null = null;
        // Without --write the model isn't asked: what it said would differ from what --write writes.
        if (describe !== null && needsDescription(text)) {
          if (!write) note = "  would ask a model to describe it";
          else {
            try {
              const chosen = await describer();
              if (chosen instanceof Error) throw chosen;
              const description = await describeFolder(chosen, guide, context, await this.openingComments(guide, sources));
              text = describeReadme(text, description) ?? text;
              note = `  described by ${description.model}`;
            } catch (error) {
              failed += 1;
              note = `  ! not described: ${error instanceof Error ? error.message : String(error)}`;
            }
          }
        }
        // A dry run's draft isn't asked for, but --write would change the README with it.
        const status = existing === null ? "created" : text !== existing || (!write && note !== null) ? "updated" : "unchanged";
        if (write && status !== "unchanged") await this.dependencies.project.writeReadme(guide.folder, text);
        this.dependencies.print(`${relative}: ${write || status === "unchanged" ? status : `would ${status === "created" ? "create" : "update"}`}`);
        if (note !== null) this.dependencies.print(note);
      }
      for (const question of guide.questions) this.dependencies.print(`  ? ${question}`);
      questions += guide.questions.length;
    }
    this.dependencies.print(`${questions} question${questions === 1 ? "" : "s"} in ${folders} folder${folders === 1 ? "" : "s"}.${write ? "" : " Nothing written: --write writes them."}`);
    return failed;
  }

  /**
   * What each of the folder's files says it is, in the comment it opens with; "" for none, or a
   * file that can't be read. Only the project's own plain files (`sources`): a recording can name
   * a link to anywhere.
   */
  private async openingComments(guide: FolderGuide, sources: string[]): Promise<Record<string, string>> {
    const comments: Record<string, string> = {};
    for (const file of guide.files) {
      if (!sources.includes(file.file)) continue;
      comments[file.name] = openingComment((await this.dependencies.project.readTextIfPresent(file.file).catch(() => null)) ?? "");
    }
    return comments;
  }

  /**
   * The working tree's state: HEAD, and every change to it, staged, unstaged and untracked, but
   * Markdown (which no test runs, and which `readmes --write` itself changes). The same
   * fingerprint means the same code to record.
   */
  private async treeFingerprint(): Promise<string> {
    const hash = this.dependencies.hashing.digest();
    const { head, diff, untracked } = await this.repository.uncommitted();
    hash.update(head).update(diff);
    for (const file of untracked.sort(byCodeUnit)) {
      hash.update(file).update("\0").update((await this.dependencies.project.readBytes(file)) ?? new Uint8Array(0)).update("\0");
    }
    return hash.hex().slice(0, VERSION_DIGITS);
  }

  async list(): Promise<void> {
    const overview = await this.library.overview();
    for (const line of listing(overview)) this.dependencies.print(line);
  }

  async forget(id: string): Promise<void> {
    const recording = await this.library.store.recording(id);
    if (recording === undefined) throw new RecordingError(`no recording ${id}`);
    // Its reviews compare it, so they go too: first, so a failure leaves none pointing at nothing.
    const reviews = await this.library.reviews.forgetRecording(recording.id);
    await this.library.store.forget(recording.id);
    this.dependencies.print(`forgot ${recording.id} (${recording.subject})${reviews > 0 ? ` and ${reviews} review${reviews === 1 ? "" : "s"} of it` : ""}`);
  }

  /** Fetches the branch from the remote (named either way: "main" or "origin/main"); the ref of the remote's copy. */
  private async fetched(name: string): Promise<string> {
    const { remote } = this.repository;
    const branch = name.startsWith(`${remote}/`) ? name.slice(remote.length + 1) : name;
    this.dependencies.print(`fetching ${branch} from ${remote}…`);
    return this.repository.fetchBranch(branch);
  }

  /** The container for commits with --sandbox (the working tree is always recorded here). */
  private async recorderFor(target: RecordTarget): Promise<Recorder> {
    if (!this.options.sandbox || target.kind === "working") return this.dependencies.recorder;
    this.sandboxRecorder ??= this.dependencies.sandbox(await this.sandboxVersion());
    return this.sandboxRecorder;
  }

  /** What the sandbox image is built from, as HEAD commits it: the recorder, the lockfile, what's left out. */
  private async sandboxVersion(): Promise<string> {
    const hash = this.dependencies.hashing.digest();
    for (const path of SANDBOX_IMAGE_SOURCES) {
      // A path HEAD doesn't have is part of the version too: absent.
      hash.update(path).update("\0").update((await this.repository.objectAtHead(path)) ?? "absent").update("\0");
    }
    return hash.hex().slice(0, VERSION_DIGITS);
  }

  /** Records into a directory of its own, and moves it into place only once it's complete. */
  private async make(plan: Plan): Promise<void> {
    const { id, target, summary, tree } = plan;
    const incoming = await this.library.store.begin(id);
    try {
      const recorder = await this.recorderFor(target);
      const recorderSource = await recorder.source();
      const rules = await this.rulesAt(target);
      if (rules.problem !== null) this.dependencies.print(`${RULES_FILE} at ${plan.label} is invalid, so every zone is inferred: ${rules.problem}`);
      await recorder.record(target, incoming.directory);
      const run = await new TraceDirectory(incoming.files).latest();
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
        ...(target.kind === "working" ? { tree: await this.treeFingerprint() } : {}),
        tests: { total: run.scenarios.length, failed: run.scenarios.filter((s) => FAILING.has(s.outcome)).length },
        architecture,
      };
      await incoming.commit(metadata);
      this.dependencies.print(`recorded ${id}: ${metadata.tests.total} tests, ${metadata.tests.failed} failed`);
    } catch (error) {
      await incoming.discard();
      throw new RecordingError(`recording ${plan.label} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The target's own runshape.json: the commit's as committed, the working tree's as on disk. */
  private async rulesAt(target: RecordTarget): Promise<CommittedRules> {
    let text: string | null;
    if (target.kind === "working") {
      try {
        // Only a missing file means "no rules"; one that can't be read is a problem to report.
        text = await this.dependencies.project.readTextIfPresent(RULES_FILE);
      } catch (error) {
        return { text: null, rules: ZoneRules.none(), problem: `it can't be read: ${(error as Error).message}` };
      }
    } else {
      // A directory, link or submodule there isn't rules to read.
      const file = await this.repository.fileAt(target.commit, RULES_FILE);
      if (file.kind === "other") return { text: null, rules: ZoneRules.none(), problem: `it is a ${file.what} in the commit, not a file` };
      text = file.kind === "file" ? file.text : null;
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
  private async keepArchitecture(incoming: IncomingRecording, run: Run, committed: CommittedRules): Promise<ArchitectureSummary> {
    const snapshot: ArchitectureSnapshot = buildPlacements(run, committed.rules);
    await incoming.keepArchitecture(committed.text, { ...snapshot, problem: committed.problem });
    const declared = snapshot.placements.filter((p) => p.source === ZoneSource.Rule).length;
    return { style: snapshot.style, rules: snapshot.rules.length, declared, inferred: snapshot.placements.length - declared, problem: committed.problem };
  }
}

/** A target's runshape.json: its text as committed (null when there's none), and the rules read from it. */
interface CommittedRules {
  text: string | null;
  rules: ZoneRules;
  /** Why the text couldn't be used; the rules are then none, and every zone inferred. */
  problem: string | null;
}

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
  /** Its folder in the review store: "<base>..<head>". */
  name: string;
  markdown: string;
}

/** The files a folder guide lists: source in the languages recorded, tests left out by the guide. */
const SOURCE_FILE = /\.(py|go|[cm]?[jt]sx?)$/;
const DECLARATION_FILE = /\.d\.[cm]?ts$/;
const README_FILE = "README.md";

/** What the sandbox image is built from: a change to any of them, in HEAD, builds a new one. */
const SANDBOX_IMAGE_SOURCES = ["recorder-ts", "package-lock.json", ".dockerignore"];

/** Where a recording was made when its metadata doesn't say (made before it did). */
const HOST_ENVIRONMENT = "host";

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
