import { execFile } from "node:child_process";

import { GitError } from "@runshape/kernel";

/** Port: run git in the project and get its output. Arguments are passed as they are, never through a shell. */
export interface Git {
  run(args: string[]): Promise<string>;
}

/**
 * A git command that hasn't finished in this long is stuck (a hung remote, a prompt nobody
 * will answer). Longer than gh's: a first fetch of a PR's history over a slow network is
 * legitimately slow.
 */
export const GIT_TIMEOUT_MS = 120_000;

export class GitCli implements Git {
  constructor(
    private readonly root: string,
    private readonly timeoutMs = GIT_TIMEOUT_MS,
  ) {}

  run(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile("git", args, { cwd: this.root, encoding: "utf8", maxBuffer: GIT_OUTPUT_LIMIT, timeout: this.timeoutMs, killSignal: "SIGKILL" }, (error, stdout, stderr) => {
        if (error && timedOut(error)) reject(new GitError(`git ${args.join(" ")}: no answer in ${this.timeoutMs} ms`));
        else if (error) reject(new GitError(`git ${args.join(" ")}: ${stderr.trim() || error.message}`));
        else resolve(stdout);
      });
    });
  }
}

/** Killed by the timeout, not for printing too much (which kills it too). */
export function timedOut(error: Error & { killed?: boolean; code?: unknown }): boolean {
  return error.killed === true && error.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
}

/** for-each-ref over every branch of a large repository stays well under this. */
const GIT_OUTPUT_LIMIT = 16 * 1024 * 1024;
