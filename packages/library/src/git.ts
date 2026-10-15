import { execFile } from "node:child_process";

/** Port: run git in the project and get its output. Arguments are passed as they are, never through a shell. */
export interface Git {
  run(args: string[]): Promise<string>;
}

export class GitError extends Error {}

export class GitCli implements Git {
  constructor(private readonly root: string) {}

  run(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile("git", args, { cwd: this.root, encoding: "utf8", maxBuffer: GIT_OUTPUT_LIMIT }, (error, stdout, stderr) => {
        if (error) reject(new GitError(`git ${args.join(" ")}: ${stderr.trim() || error.message}`));
        else resolve(stdout);
      });
    });
  }
}

/** for-each-ref over every branch of a large repository stays well under this. */
const GIT_OUTPUT_LIMIT = 16 * 1024 * 1024;
