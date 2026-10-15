// npm run runshape -- <command>: the recordings this checkout keeps (see recordings.ts).
import { execFileSync } from "node:child_process";

import { runRecordings } from "./recordings";
import { ShellRecorder } from "./shell-recorder";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
process.exitCode = await runRecordings(process.argv.slice(2), {
  root,
  recorder: new ShellRecorder(root),
  print: (line) => console.log(line),
  now: () => new Date(),
});
