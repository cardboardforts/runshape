// What the recorders that run on this machine share: a commit checked out on its own (the
// working tree untouched), a test run whose output goes to a log, and the check that a
// recording was written.
import { spawn } from "node:child_process";
import { mkdir, open, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";

import { removeAnyway } from "@runshape/infra";

import { RecordTarget } from "@runshape/kernel";

/** Where a run's output goes, beside the recording. */
export const RUN_LOG = "run.log";
/** What every recorder leaves: the pointer to its run, and the run's manifest. */
const EXPECTED = ["latest.json", join("run", "manifest.json")];
/** Enough of a log to say why, in an error message. */
const LOG_TAIL_LINES = 30;

/**
 * Runs `work` in the tree to record: the working tree itself, or the commit checked out in
 * .runshape/worktrees (inside the project, so its tools find the project's settings), removed
 * afterwards even if the tests broke its .git file.
 */
export async function inCheckout<T>(root: string, target: RecordTarget, outDirectory: string, work: (tree: string) => Promise<T>): Promise<T> {
  await mkdir(outDirectory, { recursive: true });
  if (target.kind === "working") return work(root);
  const worktree = join(root, ".runshape", "worktrees", basename(outDirectory));
  const cleanUp = async () => {
    await removeAnyway(worktree);
    // A run killed outright leaves git a worktree whose folder is gone: forgotten, or adding it again fails.
    await run("git", ["-C", root, "worktree", "prune"], { cwd: root });
  };
  await cleanUp();
  const added = await run("git", ["-C", root, "worktree", "add", "--detach", "--quiet", worktree, target.commit], { cwd: root });
  if (added.code !== 0) throw new Error(`checking out ${target.commit}: ${added.output.trim()}`);
  let failure: unknown = null;
  try {
    return await work(worktree);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      await cleanUp();
    } catch (cleanup) {
      // A cleanup that fails mustn't hide why the recording failed.
      if (failure === null) throw cleanup;
    }
  }
}

export interface Ran {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** What it printed, when not sent to a log. */
  output: string;
}

/** Runs a command, its arguments as they are (never through a shell); its output to `log` when given. */
export async function run(command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv; log?: string }): Promise<Ran> {
  const log = options.log === undefined ? null : await open(options.log, "a");
  try {
    return await new Promise<Ran>((resolve, reject) => {
      const stdio = log === null ? (["ignore", "pipe", "pipe"] as const) : (["ignore", log.fd, log.fd] as const);
      const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: [...stdio] });
      let output = "";
      child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
      child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
      child.on("error", reject);
      child.on("close", (code, signal) => resolve({ code, signal, output }));
    });
  } finally {
    await log?.close();
  }
}

/**
 * Failing tests are recorded like passing ones, so the exit code alone doesn't say whether a
 * recording was made: its files do. When they're missing, the end of the log says why.
 */
export async function requireRecording(outDirectory: string, what: string, ran: Ran): Promise<void> {
  for (const file of EXPECTED) {
    if (await stat(join(outDirectory, file)).then(() => true, () => false)) continue;
    const log = join(outDirectory, RUN_LOG);
    const tail = (await readFile(log, "utf8").catch(() => ran.output)).trim().split("\n").slice(-LOG_TAIL_LINES).join("\n");
    const ended = ran.signal !== null ? `was stopped by ${ran.signal}` : `exited with ${ran.code}`;
    throw new Error(`no recording was written (${what} ${ended}, and left no ${file}); the end of ${log}:\n${tail}`);
  }
}
