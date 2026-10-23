// npm run runshape -- list | record <ref>... [--fetch] [--again] | compare <base> [<head>] [--fetch] [--tip] | forget <id>
// Keeps .runshape/recordings: one recording per commit, plus the working tree's.
import {
  ArchitectureSummary,
  GitError,
  LibraryOverview,
  ModelChoice,
  RecordingError,
  Recordings,
  RecordingsDependencies,
  RULES_FILE,
  WORKING_TREE_ID,
} from "@runshape/core";

import { launchdJob, scheduleInstructions } from "./schedule";

/** The recordings workflow's ports (core's RecordingsDependencies), and where the project is. */
export interface CommandDependencies extends Omit<RecordingsDependencies, "comparisonLink"> {
  /** The project's root: its git repository. */
  root: string;
}

/** Where the demo's dev server serves the recordings page (npm run dev -w packages/webview). */
export const DEMO_URL = "http://localhost:5173/demo/index.html";

class UsageError extends Error {}

export async function runRecordings(argv: string[], dependencies: CommandDependencies): Promise<number> {
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
