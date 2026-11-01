// npm run runshape -- list | record | compare | review | review-requests | readmes | view | schedule | forget:
// the command line. Each command is a call on the workflows' Recordings (packages/workflows).
import { RULES_FILE } from "@runshape/architecture";
import { ArchitectureSummary, CommentSink, GitError, KeptReviewDrafts, LibraryOverview, ModelChoice, ReviewVerdict, TestConfigError, WORKING_TREE_ID } from "@runshape/kernel";
import { OpenedReview, RecordingError, Recordings, RecordingsDependencies, RecordingView, ReviewNotFound, Reviewing, SendMode } from "@runshape/workflows";

import { launchdJob, scheduleInstructions } from "./schedule";

/** The recordings workflow's ports (core's RecordingsDependencies), and where the project is. */
export interface CommandDependencies extends Omit<RecordingsDependencies, "comparisonLink"> {
  /** The project's root: its git repository. */
  root: string;
  /** The reviews' pages and the drafts beside them (`review`). */
  reviewDrafts: KeptReviewDrafts;
  /** Where `review <name> send` sends: a pull request on GitHub, or a revision request for a local agent. */
  commentSinks: { github: (pullRequest: number) => CommentSink; agent: CommentSink };
}

/** Where the demo's dev server serves the recordings page (npm run dev -w packages/webview). */
export const DEMO_URL = "http://localhost:5173/demo/index.html";

class UsageError extends Error {}

/** What the composition root reads before anything's built: which project, and which recorder. */
export interface ProjectChoice {
  /** The project's folder as given (--project=), relative to where the command was typed; null: there. */
  project: string | null;
  /** --recorder=: the language whose recorder records it, over runshape.json and the project's files. */
  recorder: string | null;
  /** The rest, for runRecordings. */
  argv: string[];
}

export function projectChoice(argv: string[]): ProjectChoice {
  const valueOf = (flag: string): string | null => {
    const given = argv.filter((arg) => arg === flag || arg.startsWith(`${flag}=`));
    if (given.length === 0) return null;
    const value = given.at(-1)!.slice(flag.length + 1);
    if (value === "") throw new UsageError(`${flag} takes a value: ${flag}=<${flag === "--project" ? "folder" : "typescript|python|go"}>`);
    return value;
  };
  const project = valueOf("--project");
  const recorder = valueOf("--recorder");
  return { project, recorder, argv: argv.filter((arg) => !/^--(project|recorder)(=|$)/.test(arg)) };
}

/** projectChoice's refusal, as the command line prints it; null when it's something else. */
export function usageProblem(error: unknown): string | null {
  return error instanceof UsageError ? `runshape: ${error.message}\n${USAGE}` : null;
}

/**
 * A command, logged at its edges: what was asked, how it ended and how long it took, and the
 * whole error when one escapes (it's rethrown: the process still fails loudly).
 */
export async function runRecordings(argv: string[], dependencies: CommandDependencies): Promise<number> {
  const { logger, now } = dependencies;
  const started = now().getTime();
  // Everything after a lone "--" is text (a comment's): never a flag, and never logged.
  const options = argv.includes("--") ? argv.slice(0, argv.indexOf("--")) : argv;
  const [command = "list"] = options.filter((arg) => !arg.startsWith("--"));
  // Flags by name only: the values (and the refs named) are the person's, not the log's.
  logger.log("info", "command.start", { command, flags: options.filter((arg) => arg.startsWith("--")).map((arg) => arg.split("=")[0]).join(" ") });
  try {
    const exit = await runCommand(argv, dependencies);
    logger.log(exit === 0 ? "info" : "warn", "command.end", { command, exit, duration_ms: now().getTime() - started });
    return exit;
  } catch (error) {
    logger.log("error", "command.failed", { command, error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? (error.stack ?? null) : null, duration_ms: now().getTime() - started });
    throw error;
  }
}

async function runCommand(everything: string[], dependencies: CommandDependencies): Promise<number> {
  // After a lone "--", the words are text as they were given (newlines and all), not flags.
  const separator = everything.indexOf("--");
  const given = separator === -1 ? everything : everything.slice(0, separator);
  const text = separator === -1 ? null : everything.slice(separator + 1);
  // For view only, "--module app.db" reads as "--module=app.db", the way every other flag takes
  // its value. Any other command keeps its arguments as given: there, --module is refused below,
  // and the word after it stays the ref or id it was.
  const isView = given.find((arg) => !arg.startsWith("--")) === "view";
  const argv: string[] = [];
  for (let i = 0; i < given.length; i += 1) {
    const next = given[i + 1];
    if (isView && given[i] === "--module" && next !== undefined && !next.startsWith("--")) {
      argv.push(`--module=${next}`);
      i += 1;
    } else argv.push(given[i]!);
  }
  // "--explain=api": a flag's name, and its value if it has one.
  const flagValues = new Map(argv.filter((arg) => arg.startsWith("--")).map((arg) => [arg.split("=")[0]!, arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : null]));
  const flags = new Set(flagValues.keys());
  const [command = "list", ...names] = argv.filter((arg) => !arg.startsWith("--"));
  const unknownFlags = [...flags].filter((flag) => !KNOWN_FLAGS.has(flag));
  const comparisonLink = (baseId: string, headId: string) => `${DEMO_URL}?base=${baseId}&head=${headId} (npm run dev -w packages/webview)`;
  const recordings = new Recordings({ ...dependencies, comparisonLink }, {
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
    if ((flags.has("--json") || flags.has("--module")) && command !== "view") throw new UsageError("--json and --module only apply to view");
    if (describe !== null && !MODEL_CHOICES.has(describe)) throw new UsageError("--describe takes claude or api (or nothing: claude -p if it runs, else the API)");
    switch (command) {
      case "list":
        for (const line of listing(await dependencies.library.overview())) dependencies.print(line);
        return 0;
      case "record":
        if (names.length === 0) throw new UsageError(`record what? ${USAGE}`);
        if (flags.has("--sandbox") && names.includes(WORKING_TREE_ID)) {
          throw new UsageError("--sandbox records commits: the working tree is yours, recorded on this machine without it");
        }
        await recordings.exclusively(async () => {
          await recordings.record(names);
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
      case "view": {
        if (names.length > 1) throw new UsageError(`view [<recording>] [--module=<module>] [--json]\n${USAGE}`);
        const module = flagValues.get("--module") ?? null;
        if (flags.has("--module") && module === null) throw new UsageError("--module takes a module, as `view` lists them");
        const view = await recordings.view(names[0] ?? null, module);
        if (flags.has("--json")) dependencies.print(JSON.stringify(view, null, 2));
        else for (const line of viewText(view)) dependencies.print(line);
        return 0;
      }
      case "schedule": {
        const at = flagValues.get("--at") ?? DEFAULT_SCHEDULE_TIME;
        dependencies.print(launchdJob({ root: dependencies.root, at, path: process.env.PATH ?? "/usr/bin:/bin" }).trimEnd());
        for (const line of scheduleInstructions(dependencies.root)) dependencies.print(line);
        return 0;
      }
      case "review":
        return await review(names, text, flags, flagValues, dependencies);
      case "forget":
        if (names.length !== 1) throw new UsageError(`forget <id>\n${USAGE}`);
        await recordings.exclusively(() => recordings.forget(names[0]!));
        return 0;
      default:
        throw new UsageError(`unknown command ${command}\n${USAGE}`);
    }
  } catch (error) {
    if (error instanceof UsageError || error instanceof GitError || error instanceof RecordingError || error instanceof TestConfigError || error instanceof ReviewNotFound) {
      dependencies.print(`runshape: ${error.message}`);
      dependencies.logger.log("warn", "command.refused", { command, error: error.message });
      return 1;
    }
    throw error;
  }
}

const KNOWN_FLAGS = new Set(["--fetch", "--again", "--tip", "--explain", "--explain-again", "--sandbox", "--limit", "--at", "--write", "--describe", "--json", "--module", "--pr", "--approve", "--request-changes", "--post"]);
const REVIEW_FLAGS = new Set(["--pr", "--approve", "--request-changes", "--post"]);
/** Before anyone's at work, after most of a day's pushes. */
const DEFAULT_SCHEDULE_TIME = "03:00";
/** A morning's worth: more than this is a queue to triage, not to record unattended. */
const DEFAULT_PULL_REQUEST_LIMIT = 20;
const MODEL_CHOICES = new Set(["auto", "claude", "api"]);
const REVIEW_USAGE = "review <base>..<head> [check <n>... | comment <n|change> -- <text> | send github|agent [--approve|--request-changes] [--pr=N] [--post]]";
const USAGE =
  `usage: npm run runshape -- [--project=<folder>] [--recorder=typescript|python|go] list | record <ref|working>... [--fetch] [--again] [--sandbox] | compare <base> [<head>] [--fetch] [--tip] [--sandbox] [--explain[=claude|api]] | review-requests [--explain] [--limit=N] | readmes [--write] [--describe[=claude|api]] | view [<recording>] [--module=<module>] [--json] | ${REVIEW_USAGE} | schedule [--at=HH:MM] | forget <id>`;

/**
 * `review <name>`: what there is to check off and the comments so far; `check` and `comment`
 * add to the draft; `send` sends the finished review. To GitHub it only shows what it would
 * post, unless --post says to post it: posting can't be taken back. A revision request for a
 * local agent is a file here, written straight away.
 */
async function review(names: string[], text: string[] | null, flags: Set<string>, flagValues: Map<string, string | null>, dependencies: CommandDependencies): Promise<number> {
  const [name, action, ...rest] = names;
  if (text !== null && action !== "comment") throw new UsageError(`text after -- is a comment's: review <name> comment <n|change> -- <text>`);
  if (name === undefined) throw new UsageError(`${REVIEW_USAGE}: the names are the folders in .runshape/reviews`);
  const misplaced = [...flags].filter((flag) => REVIEW_FLAGS.has(flag) && action !== "send");
  if (misplaced.length > 0) throw new UsageError(`${misplaced.join(", ")} only ${misplaced.length === 1 ? "applies" : "apply"} to review <name> send`);
  const reviewing = new Reviewing(dependencies.reviewDrafts, dependencies.logger, dependencies.now, (body) => dependencies.hashing.sha256(body));
  const print = dependencies.print;
  const refused = (errors: string[]) => {
    for (const error of errors) print(`runshape: ${error}`);
    return errors.length > 0 ? 1 : 0;
  };
  switch (action) {
    case undefined:
      for (const line of reviewText(name, await reviewing.open(name))) print(line);
      return 0;
    case "check":
      if (rest.length === 0) throw new UsageError(`check what? ${REVIEW_USAGE}`);
      return refused((await reviewing.check(name, rest)).errors);
    case "comment": {
      // The text after "--" can start with "--" or hold newlines; plain words after the target work too.
      const [on, ...words] = rest;
      const body = text ?? words;
      if (on === undefined || body.length === 0 || (text !== null && words.length > 0)) throw new UsageError(`comment <n|change> -- <text>: ${REVIEW_USAGE}`);
      return refused((await reviewing.comment(name, on, body.join(" "))).errors);
    }
    case "send": {
      const [to] = rest;
      if (flags.has("--approve") && flags.has("--request-changes")) throw new UsageError("--approve or --request-changes, not both");
      // Exactly --post: "--post=yes" isn't a yes to anything in particular.
      if (flags.has("--post") && flagValues.get("--post") !== null) throw new UsageError("--post takes no value: it posts exactly what the last preview showed");
      const verdict = flags.has("--approve") ? ReviewVerdict.Approve : flags.has("--request-changes") ? ReviewVerdict.RequestChanges : ReviewVerdict.Comment;
      let sink: CommentSink;
      if (to === "agent") {
        if (flags.has("--post") || flags.has("--pr")) throw new UsageError("--post and --pr are for send github: a revision request stays on this machine");
        sink = dependencies.commentSinks.agent;
      } else if (to === "github") {
        sink = dependencies.commentSinks.github(await pullRequestOf(name, flagValues.get("--pr") ?? null, flags.has("--pr"), reviewing));
      } else throw new UsageError(`send it where? github or agent: ${REVIEW_USAGE}`);
      // Only GitHub is outward, and posts only what was previewed: a revision request is this
      // machine's, replaced by the next.
      const mode = to === "agent" ? SendMode.Deliver : flags.has("--post") ? SendMode.Post : SendMode.Preview;
      const sent = await reviewing.send(name, sink, verdict, mode);
      if ("errors" in sent) return refused(sent.errors);
      if ("preview" in sent) {
        print(`Would send to ${sent.preview.where} (${verdict}), preview ${sent.digest}:`);
        print("");
        for (const line of sent.preview.text.trimEnd().split("\n")) print(`  ${line}`);
        print("");
        print(`Nothing posted. To post exactly this (preview ${sent.digest}), run the same with --post.`);
        return 0;
      }
      print(`Sent ${sent.delivered.comments} comment${sent.delivered.comments === 1 ? "" : "s"} (${verdict}) to ${sent.delivered.where}.`);
      return 0;
    }
    default:
      throw new UsageError(`unknown review action ${action}: ${REVIEW_USAGE}`);
  }
}

/** --pr=N, else the pull request the review is of. */
async function pullRequestOf(name: string, given: string | null, flagged: boolean, reviewing: Reviewing): Promise<number> {
  if (flagged && (given === null || !/^[1-9]\d*$/.test(given))) throw new UsageError("--pr takes a pull request's number");
  if (given !== null) return Number(given);
  const reviewed = (await reviewing.open(name)).draft.change.pullRequest?.number ?? null;
  if (reviewed === null) throw new UsageError("which pull request? This review isn't of one: name it with --pr=N");
  return reviewed;
}

const STATE_MARK = { "to-review": "[ ]", checked: "[x]", "changed-since-checked": "[~]" } as const;

/** The review command's text: each thing to check off, numbered, with its comments. */
function reviewText(name: string, opened: OpenedReview): string[] {
  const { page, progress, unpinned } = opened;
  const done = progress.filter((entry) => entry.state === "checked").length;
  const lines = [`review ${name}: ${truncate(page.head.subject)} (${page.head.commit.slice(0, 12)}) against ${page.base.commit.slice(0, 12)}`, page.headline, ""];
  if (progress.length === 0) lines.push("Nothing to check off: the tests behave as before.");
  else lines.push(`To check off (${done} of ${progress.length} done; [~] changed since you checked it):`);
  progress.forEach((entry, index) => {
    const beams = entry.item.beams.map((beam) => `${beam.tests.length} ${beam.kind}`).join(", ");
    lines.push(`  ${STATE_MARK[entry.state]} ${String(index + 1).padStart(3)}. ${entry.item.kind} ${entry.item.label}${beams ? `: tests ${beams}` : ""}`);
    for (const comment of entry.comments) lines.push(`          > ${comment.body}`);
  });
  if (unpinned.length > 0) {
    lines.push("", "Comments on the change, or on what this comparison no longer shows:");
    for (const comment of unpinned) lines.push(`  ${comment.key}: ${comment.body}`);
  }
  lines.push("", `Next: review ${name} check <n>... | comment <n|change> -- <text> | send github|agent`);
  return lines;
}

/** The view command's text: each level's boxes in reading order, then its calls. --json has everything. */
function viewText(view: RecordingView): string[] {
  const lines = [`recording ${view.recording} (${view.commit.slice(0, 12)} ${truncate(view.subject)})`];
  for (const level of view.levels) {
    const where = level.level.kind === "module" ? `${level.level.module}, opened` : level.level.kind;
    lines.push("", `${where}, drawn ${level.style}: ${level.boxes.length} boxes, ${level.lines.length} calls${level.hidden.nodes > 0 ? ` (${level.hidden.nodes} quieter boxes left out)` : ""}`);
    for (const box of level.boxes) lines.push(`  ${box.label} [${box.zone}] ${box.calls} calls, ${box.tests} tests${box.opens ? ` (--module=${box.opens})` : ""}`);
    const label = new Map(level.boxes.map((box) => [box.name, box.label]));
    for (const line of level.lines) lines.push(`  ${label.get(line.from)} -> ${label.get(line.to)}: ${line.calls}${line.violation ? `  ✗ ${line.violation}` : ""}`);
  }
  return lines;
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
