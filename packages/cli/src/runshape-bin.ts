// npm run runshape -- [--project=<folder>] <command>: the recordings a project keeps (see recordings.ts).
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ArrangementFile, assertPlainRecording, GhIssues, GhPullRequests, GitCli, GitRepository, NodeProjectFiles, projectLibrary, projectRecorders, projectTestConfig, UnchosenRecorder } from "@runshape/adapters";
import { TestConfigError } from "@runshape/kernel";
import { LogfmtLogger, nodeHashing } from "@runshape/infra";

import { chooseModel } from "./choose-model";
import { projectChoice, runRecordings, usageProblem } from "./recordings";

// Ctrl-C reaches the recorder too, which stops; this process then cleans up its half-written
// recording and the lock instead of dying with them in place.
process.on("SIGINT", () => console.log("runshape: stopping…"));

let choice;
try {
  choice = projectChoice(process.argv.slice(2));
} catch (error) {
  console.log(usageProblem(error) ?? String(error));
  process.exit(1);
}
// npm runs scripts from Runshape's checkout; INIT_CWD is where the command was typed.
const typedIn = process.env.INIT_CWD ?? process.cwd();
const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: resolve(typedIn, choice.project ?? "."), encoding: "utf8" }).trim();
// Runshape's own checkout, where the recorders are: this file is packages/cli/dist/runshape.mjs in it.
const home = fileURLToPath(new URL("../../..", import.meta.url));
const repository = new GitRepository(new GitCli(root));
// Logs go to a file, not the terminal: what's printed is for the person, the log is for looking
// back (a night's review-requests, say). One id per invocation ties its lines together.
/** Enough to tell one night's runs apart in a grep, short enough to type. */
const RUN_ID_LENGTH = 8;
// A log that can't be written is said once and dropped: it never stops a command (see LogfmtLogger).
const logs = join(root, ".runshape", "logs");
const writeLog = (line: string) => {
  mkdirSync(logs, { recursive: true });
  // Only its owner reads it: errors can carry more than the redaction catches.
  appendFileSync(join(logs, "runshape.log"), `${line}\n`, { mode: 0o600 });
};
const logFailed = (error: unknown) => console.error(`runshape: not logging to ${logs}: ${error instanceof Error ? error.message : String(error)}`);
const logger = new LogfmtLogger(writeLog, () => new Date(), {}, logFailed).with({ service: "runshape", run: randomUUID().slice(0, RUN_ID_LENGTH) });

// The project's recorder, by its language. One it can't tell still lets list, view and forget
// run; a command that records says why.
let recorders;
try {
  const config = await projectTestConfig(root, choice.recorder);
  logger.log("info", "recorder.chosen", { language: config.language, chosen_by: config.chosenBy });
  recorders = projectRecorders(config, { home, homeRepository: new GitRepository(new GitCli(home)), root, hashing: nodeHashing });
} catch (error) {
  if (!(error instanceof TestConfigError)) throw error;
  logger.log("warn", "recorder.unchosen", { problems: error.problems.join("; ") });
  const unchosen = new UnchosenRecorder(error);
  recorders = { host: unchosen, sandbox: async () => unchosen };
}

process.exitCode = await runRecordings(choice.argv, {
  root,
  repository,
  library: projectLibrary(root, repository),
  arrangements: new ArrangementFile(root),
  project: new NodeProjectFiles(root),
  hashing: nodeHashing,
  checkSandboxed: assertPlainRecording,
  recorder: recorders.host,
  sandbox: recorders.sandbox,
  print: (line) => console.log(line),
  logger,
  now: () => new Date(),
  models: (choice) => chooseModel(choice, process.env),
  pullRequests: new GhPullRequests(root),
  // GitHub Issues, through the same gh login. Jira and the like are TicketSource adapters still to write.
  tickets: [new GhIssues(root)],
});
