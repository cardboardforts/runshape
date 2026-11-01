// A stand-in gh for the GitHub adapters' tests: records each call's arguments and answers with
// what a shell snippet prints.
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach } from "vitest";

const made: string[] = [];
afterEach(() => {
  for (const directory of made.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** Records each call's arguments (any text, newlines and all), and answers with what `answer` (shell, with the call's "$@") prints. */
export function fakeGh(answer: string): { directory: string; command: string; asked: () => string[][]; inputs: () => string[] } {
  const directory = mkdtempSync(join(tmpdir(), "runshape-gh-"));
  made.push(directory);
  const seen = join(directory, "seen.txt");
  const command = join(directory, "gh");
  // Each argument ends in a unit separator, each call in a record separator: a body can hold blank lines.
  const stdin = join(directory, "stdin.txt");
  writeFileSync(command, `#!/bin/sh\nprintf '%s\\037' "$@" >> "${seen}"\nprintf '\\036' >> "${seen}"\ncat >> "${stdin}"\nprintf '\\036' >> "${stdin}"\n${answer}\n`);
  chmodSync(command, 0o755);
  const asked = () => (existsSync(seen) ? readFileSync(seen, "utf8").split("\x1e").slice(0, -1).map((call) => call.split("\x1f").slice(0, -1)) : []);
  /** What each call was given on stdin ("" for none), in order. */
  const inputs = () => (existsSync(stdin) ? readFileSync(stdin, "utf8").split("\x1e").slice(0, -1) : []);
  return { directory, command, asked, inputs };
}
