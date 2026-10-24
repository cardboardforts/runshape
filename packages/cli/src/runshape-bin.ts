// npm run runshape -- <command>: the recordings this checkout keeps (see recordings.ts).
import { execFileSync } from "node:child_process";

import { assertPlainRecording, DockerRecorder, GhPullRequests, NodeProjectFiles, sandboxVersion, ShellRecorder } from "@runshape/adapters";
import { nodeHashing } from "@runshape/infra";
import { GitCli, GitRepository, projectLibrary } from "@runshape/adapters";

import { chooseModel } from "./choose-model";
import { runRecordings } from "./recordings";

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
  sandbox: async () => new DockerRecorder(root, await sandboxVersion(repository, nodeHashing)),
  print: (line) => console.log(line),
  now: () => new Date(),
  models: (choice) => chooseModel(choice, process.env),
  pullRequests: new GhPullRequests(root),
});
