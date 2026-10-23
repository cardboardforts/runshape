// npm run runshape -- <command>: the recordings this checkout keeps (see recordings.ts).
import { execFileSync } from "node:child_process";

import { GitCli, GitRepository, projectLibrary } from "@runshape/library";

import { chooseModel } from "./models";
import { assertPlainRecording, DockerRecorder } from "./docker-recorder";
import { nodeHashing } from "./node-hashing";
import { NodeProjectFiles } from "./project-files";
import { GhPullRequests } from "./pull-requests";
import { runRecordings } from "./recordings";
import { ShellRecorder } from "./shell-recorder";

// Ctrl-C reaches the recorder too, which stops; this process then cleans up its half-written
// recording and the lock instead of dying with them in place.
process.on("SIGINT", () => console.log("runshape: stopping…"));

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const repository = new GitRepository(new GitCli(root));
process.exitCode = await runRecordings(process.argv.slice(2), {
  root,
  repository,
  library: projectLibrary(root, repository),
  project: new NodeProjectFiles(root),
  hashing: nodeHashing,
  checkSandboxed: assertPlainRecording,
  recorder: new ShellRecorder(root, nodeHashing),
  sandbox: (recorderVersion) => new DockerRecorder(root, recorderVersion),
  print: (line) => console.log(line),
  now: () => new Date(),
  models: (choice) => chooseModel(choice, process.env),
  pullRequests: new GhPullRequests(root),
});
