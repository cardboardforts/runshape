// npm run runshape -- <command>: the recordings this checkout keeps (see recordings.ts).
import { execFileSync } from "node:child_process";

import { chooseModel } from "./models";
import { DockerRecorder } from "./docker-recorder";
import { GhPullRequests } from "./pull-requests";
import { runRecordings } from "./recordings";
import { ShellRecorder } from "./shell-recorder";

// Ctrl-C reaches the recorder too, which stops; this process then cleans up its half-written
// recording and the lock instead of dying with them in place.
process.on("SIGINT", () => console.log("runshape: stopping…"));

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
process.exitCode = await runRecordings(process.argv.slice(2), {
  root,
  recorder: new ShellRecorder(root),
  sandbox: (recorderVersion) => new DockerRecorder(root, recorderVersion),
  print: (line) => console.log(line),
  now: () => new Date(),
  models: (choice) => chooseModel(choice, process.env),
  pullRequests: new GhPullRequests(root),
});
