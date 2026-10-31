// gh, run as the person: their own login, arguments passed as they are (never through a shell).
import { execFile } from "node:child_process";

/** gh's answer as text; an error that says which command failed and gh's own reason. */
export function runGh(command: string, cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, encoding: "utf8", maxBuffer: GH_OUTPUT_LIMIT }, (error, stdout, stderr) => {
      if (error) reject(new GhError(`gh ${args.slice(0, 2).join(" ")}: ${stderr.trim() || error.message}`, stderr));
      else resolve(stdout);
    });
  });
}

/** gh's answer read as JSON; an error naming the command when it's something else. */
export async function ghJson<T>(command: string, cwd: string, args: string[]): Promise<T> {
  const output = await runGh(command, cwd, args);
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
  ) {
    super(message);
  }
}

/** A PR body or an issue with long logs pasted in stays well under this. */
const GH_OUTPUT_LIMIT = 8 * 1024 * 1024;
