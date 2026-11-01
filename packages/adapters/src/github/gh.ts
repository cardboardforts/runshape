// gh, run as the person: their own login, arguments passed as they are (never through a shell).
import { execFile } from "node:child_process";

import { timedOut } from "../git/git-cli";

/** A gh call that hasn't answered in this long is stuck (a network hang, a prompt): the review goes on without it. */
export const GH_TIMEOUT_MS = 30_000;

/** gh's answer as text; an error that says which command failed and gh's own reason. `input` goes to its stdin. */
export function runGh(command: string, cwd: string, args: string[], timeoutMs = GH_TIMEOUT_MS, input: string | null = null): Promise<string> {
  const named = `gh ${args.slice(0, 2).join(" ")}`;
  // GH_PROMPT_DISABLED: gh never stops to ask (a login, a repository to pick) in an unattended run.
  const env = { ...process.env, GH_PROMPT_DISABLED: "1" };
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { cwd, env, encoding: "utf8", maxBuffer: GH_OUTPUT_LIMIT, timeout: timeoutMs, killSignal: "SIGKILL" }, (error, stdout, stderr) => {
      if (error && timedOut(error)) reject(new GhError(`${named}: no answer in ${timeoutMs} ms`, "", true));
      else if (error) reject(new GhError(`${named}: ${stderr.trim() || error.message}`, stderr));
      else resolve(stdout);
    });
    // Without input, stdin is closed at once: gh never waits on it.
    child.stdin?.end(input ?? undefined);
  });
}

/** gh's answer read as JSON; an error naming the command when it's something else. */
export async function ghJson<T>(command: string, cwd: string, args: string[], timeoutMs = GH_TIMEOUT_MS): Promise<T> {
  const output = await runGh(command, cwd, args, timeoutMs);
  try {
    return JSON.parse(output) as T;
  } catch (error) {
    throw new Error(`gh ${args.slice(0, 2).join(" ")} answered something other than JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export class GhError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    /** No answer in time: what gh was doing may or may not have happened. */
    readonly timedOut = false,
  ) {
    super(message);
  }
}

/** A PR body or an issue with long logs pasted in stays well under this. */
const GH_OUTPUT_LIMIT = 8 * 1024 * 1024;
