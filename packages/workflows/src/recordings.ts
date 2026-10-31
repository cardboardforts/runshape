// The recordings workflow (runshape list | record | compare | review-requests | readmes |
// forget): the CLI parses the command line and wires the adapters; this decides and records.
import { ArchitectureSummary, byCodeUnit, CommitSummary, GitError, Grouping, Hashing, IncomingRecording, LanguageModel, Library, LibraryBusy, Logger, ModelChoice, Outcome, Phase, ProjectFiles, PullRequests, PullRequestSummary, Recorder, recordingIdFor, RecordingMetadata, RecordTarget, Repository, RequestedReview, RequestedReviews, ReviewHighlights, reviewName, Run, SANDBOX_SUFFIX, TraceDirectory, VERSION_DIGITS, WORKING_TREE_ID, ZoneSource } from "@runshape/kernel";
import { ArchitectureSnapshot, buildFolderGuides, buildPlacements, describeFolder, describeReadme, FolderGuide, folderGuideMarkdown, mergeIntoReadme, needsDescription, openingComment, RULES_FILE, ZoneRules, ZoneRulesError } from "@runshape/architecture";
import { ChangeContext, explainChange, Explanation, explanationInputs, explanationMarkdown } from "@runshape/explainer";
import { AgentLevel, layoutForAgents } from "@runshape/visualizer";

import { buildReviewBundle, ReviewBundle, reviewBundleMarkdown, reviewHighlights } from "./review-bundle";
import { buildReviewPage } from "./review-page";
import { ArrangementStore, ViewerSession } from "./session";
import { stackOrder } from "./stacks";

/** What the recordings workflow is given: its ports, and how to talk to the person. */
export interface RecordingsDependencies {
  repository: Repository;
  /** The project's own working tree: folder guides' READMEs, the working tree's runshape.json. */
  project: ProjectFiles;
  hashing: Hashing;
  /** Its recordings and reviews. */
  library: Library;
  /** Checks what the sandbox left before anything here reads or moves it. */
  checkSandboxed: (directory: string) => Promise<void>;
  recorder: Recorder;
  /** Records commits in a container (`--sandbox`): made when first needed. */
  sandbox: () => Promise<Recorder>;
  print: (line: string) => void;
  /** Events to look back on (each pull request's outcome and how long it took), apart from what's printed. */
  logger: Logger;
  now: () => Date;
  /** The language model `--explain` asks. */
  models: (choice: ModelChoice) => Promise<LanguageModel>;
  pullRequests: PullRequests;
  /** Where a person can look at a comparison: a page to open, and how. */
  comparisonLink: (baseId: string, headId: string) => string;
  /** The boxes a person moved in the viewer: `view` shows them where they were put. */
  arrangements?: ArrangementStore | null;
}

const FAILING = new Set<string>([Outcome.Failed, Outcome.Error, Outcome.UnexpectedPass]);

/** `runshape view`: a kept recording as the viewer draws it, level by level. */
export interface RecordingView {
  recording: string;
  commit: string;
  subject: string;
  /** The module view's modules: what `--module` takes. */
  modules: string[];
  /** The level the viewer opens at, then the module asked for, opened. */
  levels: AgentLevel[];
}

/** A recording or comparison couldn't be made: said to the person as it is. */
export class RecordingError extends Error {}

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

/**
 * The recordings workflow: what a name records as, where it may be recorded (here, or in the
 * sandbox for code that may be someone else's), recording what's missing, comparing two, explaining
 * a comparison, reviewing the pull requests asking for review, and folder guides. Everything
 * outside core comes in through its ports (recordings-ports.ts).
 */
export class Recordings {
  private readonly library: Library;
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
      if (error instanceof LibraryBusy) throw new RecordingError(`another recording is running (process ${error.holder}); if it isn't, delete ${error.lockFile}`);
      throw error;
    }
  }

  /** Records each name that isn't recorded yet: "working", branches, tags or commits. */
  async record(names: string[]): Promise<void> {
    if (names.includes(WORKING_TREE_ID)) await this.refuseCheckedOutPullRequest();
    const plans: Plan[] = [];
    for (const name of names) plans.push(await this.plan(name, { fetch: true }));
    for (const plan of await this.place(plans, { workingHead: false })) await this.ensure(plan);
  }

  /** What `name` names: "working", or a branch, tag or commit (fetched from origin first with --fetch). */
  private async plan(name: string, { fetch }: { fetch: boolean }): Promise<Plan> {
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
    this.dependencies.print(`open ${this.dependencies.comparisonLink(base.id, head.id)}`);
    return { review, base, head };
  }

  /**
   * Where each planned commit records, decided on the commits themselves, after any fetch.
   * Yours means merged: a commit your default branch holds (main, here or on origin). Anything
   * else (another branch, yours too; a teammate's; a tag; a hash) may be someone else's code,
   * and the whole command records in the sandbox; against the working tree (yours, recorded
   * here) it can't be compared. Returns the plans with their recordings' ids.
   */
  private async place(plans: Plan[], { workingHead }: { workingHead: boolean }): Promise<Plan[]> {
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
  private async refuseCheckedOutPullRequest(): Promise<void> {
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
    // A stack bottom first, the order to read them in. Each is still compared with where it left
    // its own base branch, which for a stacked PR is the branch of the one below.
    for (const { pr, stackedOn } of stackOrder(requested)) {
      const name = `#${pr.number} ${pr.title}`;
      const log = this.dependencies.logger.with({ pr: pr.number });
      const started = this.dependencies.now().getTime();
      const took = () => this.dependencies.now().getTime() - started;
      const entry: RequestedReview = { ...pr, head: pr.headRefOid, review: null, explained: false, problem: null, summary: null, stackedOn };
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
        entry.summary = reviewHighlights(compared.review.bundle);
        if (explain !== null) {
          try {
            await this.explain(compared.review, compared.base, compared.head, explain);
            entry.explained = true;
          } catch (error) {
            entry.problem = error instanceof Error ? error.message : String(error);
          }
        }
        this.dependencies.print(`${name}: reviewed${entry.explained ? " and explained" : entry.problem ? `; ${entry.problem}` : ""}`);
        log.log(entry.problem === null ? "info" : "warn", "pr.reviewed", { head: entry.head, review: entry.review, explained: entry.explained, problem: entry.problem, duration_ms: took() });
      } catch (error) {
        // Whatever stopped this one, the rest go on.
        entry.problem = error instanceof Error ? error.message : String(error);
        this.dependencies.print(`${name}: failed: ${entry.problem}`);
        log.log("error", "pr.failed", { head: pr.headRefOid, error: entry.problem, stack: error instanceof Error ? (error.stack ?? null) : null, duration_ms: took() });
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
  private async forkPoint(baseName: string, base: Plan, head: Plan): Promise<Plan> {
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
  private async ensure(plan: Plan, { sameRecorder = false } = {}): Promise<void> {
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
  private async writeReview(base: { asked: string; plan: Plan }, head: { asked: string; plan: Plan }): Promise<SavedReview> {
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
    await reviews.saveReview(name, bundle, reviewBundleMarkdown(bundle), buildReviewPage(bundle));
    // An explanation of an older review mustn't sit beside this one looking current.
    const explained = (await reviews.explanation(name)) as Explanation | null;
    if (explained !== null && explained.basedOn.review !== this.dependencies.hashing.sha256(reviewBundleMarkdown(bundle))) await reviews.dropExplanation(name);
    return { bundle, name, markdown: reviews.shownReview(name) };
  }

  /**
   * Asks a language model why the change was made, from the review (names only) and the commit
   * messages between the two sides; saved beside the review, which it doesn't change. Asked
   * again only when the review or the commits changed (or with --again).
   */
  async explain(review: SavedReview, base: Plan, head: Plan, choice: ModelChoice): Promise<void> {
    const where = this.library.reviews.shownExplanation(review.name);
    const { sha256 } = this.dependencies.hashing;
    try {
      const context: ChangeContext = { commits: await this.repository.commitsBetween(base.summary.commit, head.summary.commit), uncommittedChanges: head.tree.dirty || base.tree.dirty };
      const reviewMarkdown = reviewBundleMarkdown(review.bundle);
      const inputs = explanationInputs(reviewMarkdown, context, sha256);
      const model = await this.dependencies.models(choice);
      const saved = (await this.library.reviews.explanation(review.name)) as Explanation | null;
      if (saved !== null && !this.options.explainAgain && saved.model === model.name && JSON.stringify(saved.basedOn) === JSON.stringify(inputs)) {
        this.dependencies.print(`explanation: ${where} (current: same review, commits and model)`);
        return;
      }
      const explanation = await explainChange(model, reviewMarkdown, context, this.dependencies.now().toISOString(), sha256);
      await this.library.reviews.saveExplanation(review.name, explanation, explanationMarkdown(explanation));
      this.dependencies.print(`explanation: ${where} (by ${explanation.model})`);
    } catch (error) {
      if (error instanceof GitError) throw error;
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
    await this.dependencies.checkSandboxed(this.library.store.pathOf(id));
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

  /**
   * What a person sees of a kept recording (the newest, when none is named), for an agent: the
   * level the viewer opens at (its modules, when it has more than one), and with `module` that
   * module opened, as clicking it would. Drawn the way the viewer draws it first: the tests'
   * own calls, middleware as one box, the recording's own runshape.json.
   */
  async view(id: string | null, module: string | null): Promise<RecordingView> {
    const chosen = id ?? (await this.library.overview()).recordings[0]?.id;
    if (chosen === undefined) throw new RecordingError("nothing is recorded yet: npm run runshape -- record working");
    const recording = await this.library.store.recording(chosen);
    if (recording === undefined) throw new RecordingError(`there's no recording ${chosen} (npm run runshape -- list shows what's kept)`);
    const session = new ViewerSession(await this.runOf(chosen), { sources: { readLines: async () => null }, rules: (await this.rulesOf(chosen)) ?? undefined, arrangements: this.dependencies.arrangements ?? null });
    const modules = session.modules();
    const grouping: Grouping = modules.length > 1 ? { collapseMiddleware: true, modules } : { collapseMiddleware: true };
    if (module !== null && !modules.includes(module)) {
      throw new RecordingError(`${module} isn't one of recording ${chosen}'s modules: ${modules.length > 1 ? modules.join(", ") : "it has only one, so it opens at its classes"}`);
    }
    const levels: AgentLevel[] = [];
    for (const opened of module === null ? [undefined] : [undefined, module]) {
      const response = await session.handle({ type: "graph", phases: [Phase.Call], grouping, opened });
      if (response?.type !== "graph") throw new RecordingError(`recording ${chosen} can't be drawn: ${response?.type === "error" ? response.message : "no layout"}`);
      levels.push(layoutForAgents(response.layout));
    }
    return { recording: chosen, commit: recording.commit, subject: recording.subject, modules, levels };
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
    this.sandboxRecorder ??= await this.dependencies.sandbox();
    return this.sandboxRecorder;
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

/** Where a recording was made when its metadata doesn't say (made before it did). */
const HOST_ENVIRONMENT = "host";

