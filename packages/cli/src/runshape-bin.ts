// npm run runshape -- <command>: the recordings this checkout keeps (see recordings.ts).
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { assertPlainRecording, DockerRecorder, GhPullRequests, GitCli, GitRepository, NodeProjectFiles, projectLibrary, sandboxVersion, ShellRecorder } from "@runshape/adapters";
import { LogfmtLogger, nodeHashing } from "@runshape/infra";

import { chooseModel } from "./choose-model";
import { runRecordings } from "./recordings";

// Ctrl-C reaches the recorder too, which stops; this process then cleans up its half-written
// recording and the lock instead of dying with them in place.
process.on("SIGINT", () => console.log("runshape: stopping…"));

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const repository = new GitRepository(new GitCli(root));
// Logs go to a file, not the terminal: what's printed is for the person, the log is for looking
// back (a night's review-requests, say). One id per invocation ties its lines together.
/** Enough to tell one night's runs apart in a grep, short enough to type. */
const RUN_ID_LENGTH = 8;
const logs = join(root, ".runshape", "logs");
mkdirSync(logs, { recursive: true });
const logger = new LogfmtLogger((line) => appendFileSync(join(logs, "runshape.log"), `${line}\n`), () => new Date()).with({ service: "runshape", run: randomUUID().slice(0, RUN_ID_LENGTH) });
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
  logger,
  now: () => new Date(),
  models: (choice) => chooseModel(choice, process.env),
  pullRequests: new GhPullRequests(root),
});
