/**
 * A recorder per language behind one port (PLAN.md Phase 7): the CLI reads the project's
 * TestConfig (projectTestConfig), and projectRecorders builds that language's recorder, here and
 * in the sandbox. Here they run for real: Runshape's own Python and Go recorders, on the
 * projects their own tests record (recorder/tests/sample_shop, examples/go-shop), each checked
 * in as a repository of its own. Each leaves what the recordings library keeps: latest.json and
 * run/manifest.json, in the universal trace format, and the commit's checkout gone.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { NodeFiles, nodeHashing } from "@runshape/infra";
import { TestConfigError, TraceDirectory } from "@runshape/kernel";

import { GitCli, GitRepository } from "../src";
import { projectRecorders, projectTestConfig, UnchosenRecorder } from "../src/recorders/recorders";
import { gitIn } from "./repository";

const HOME = join(import.meta.dirname, "..", "..", "..");
/** Compiling the recorder and the module's tests, then running them. */
const RECORDING_TIMEOUT_MS = 120_000;

/** A project checked in from one of Runshape's own: its first commit, and where it is. */
function projectFrom(source: string): { root: string; commit: string } {
  const root = mkdtempSync(join(tmpdir(), "runshape-project-"));
  cpSync(source, root, { recursive: true, filter: (path) => !path.includes("__pycache__") && !path.includes(".runshape") });
  const git = gitIn(root);
  git("init", "--quiet", "--initial-branch=main");
  writeFileSync(join(root, ".git", "info", "exclude"), ".runshape/\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "First");
  return { root, commit: git("rev-parse", "HEAD") };
}

async function recorderFor(root: string) {
  const config = await projectTestConfig(root, null);
  return { config, recorders: projectRecorders(config, { home: HOME, homeRepository: new GitRepository(new GitCli(HOME)), root, hashing: nodeHashing }) };
}

/** A recording as the library reads it: through the kernel's TraceDirectory, as the universal trace. */
async function recorded(out: string) {
  const run = await new TraceDirectory(new NodeFiles(out)).latest();
  return { language: run.language, scenarios: run.scenarios.map((scenario) => `${scenario.outcome} ${scenario.name}`), problems: run.problems };
}

const pythonWithPytest = (() => {
  try {
    execFileSync("python3", ["-c", "import pytest"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("projectRecorders", () => {
  test("Go: go-shop (go.mod) is recorded at a commit by recorder-go, the checkout removed afterwards", { timeout: RECORDING_TIMEOUT_MS }, async () => {
    const { root, commit } = projectFrom(join(HOME, "examples", "go-shop"));
    const out = join(root, ".runshape", "recordings", ".incoming-go");
    const { config, recorders } = await recorderFor(root);

    await recorders.host.record({ kind: "commit", commit }, out);

    expect({ chosen: `${config.language} (${config.chosenBy})`, environment: recorders.host.environment, ...(await recorded(out)), checkouts: readdirSync(join(root, ".runshape", "worktrees")) }).toEqual({
      chosen: "go (go.mod)",
      environment: "host",
      language: "go",
      problems: [],
      scenarios: expect.arrayContaining(["passed TestTotalAddsEveryItem", "passed TestPlaceThenFetchAnOrder"]),
      checkouts: [],
    });
  });

  test.skipIf(!pythonWithPytest)("Python: the sample shop (pytest.ini) is recorded in the working tree by recorder/, nothing installed into it (needs a python3 with pytest)", { timeout: RECORDING_TIMEOUT_MS }, async () => {
    const { root } = projectFrom(join(HOME, "recorder", "tests", "sample_shop"));
    const out = join(root, ".runshape", "recordings", ".incoming-py");
    const { config, recorders } = await recorderFor(root);

    await recorders.host.record({ kind: "working" }, out);

    expect({ chosen: `${config.language} (${config.chosenBy})`, ...(await recorded(out)), log: existsSync(join(out, "run.log")) }).toEqual({
      chosen: "python (pytest.ini)",
      language: "python",
      // The sample shop's own xfail: a failing test is recorded like a passing one.
      scenarios: ["passed test_place_order", "passed test_rejects_empty_order", "passed test_place_order_later", "passed test_place_order_in_worker_thread", "xfailed test_rejects_negative_items"],
      problems: [],
      log: true,
    });
  });

  test("a project's committed .venv/bin/python is never run: a pull request checked out here could ship one, and recording main would run it", async () => {
    const { root } = projectFrom(join(HOME, "recorder", "tests", "sample_shop"));
    const planted = join(root, ".venv", "bin", "python");
    mkdirSync(join(root, ".venv", "bin"), { recursive: true });
    writeFileSync(planted, `#!/bin/sh\ntouch "${root}/ran"\n`, { mode: 0o755 });
    gitIn(root)("add", "--force", planted);
    const { recorders } = await recorderFor(root);

    const failure = await recorders.host.record({ kind: "working" }, join(root, ".runshape", "recordings", ".incoming-planted")).catch((error: Error) => error.message);

    expect({ failure, ran: existsSync(join(root, "ran")) }).toEqual({
      failure: "the Python to record with (.venv/bin/python) is a file git tracks: that's the commit's code, not an environment of yours, so it isn't run here",
      ran: false,
    });
  });

  test("a run that writes no recording fails with the end of its log, not a missing file later", { timeout: RECORDING_TIMEOUT_MS }, async () => {
    const { root } = projectFrom(join(HOME, "examples", "go-shop"));
    writeFileSync(join(root, "go.mod"), "this is not a go.mod\n");
    const out = join(root, ".runshape", "recordings", ".incoming-broken");
    const { recorders } = await recorderFor(root);

    const failure = await recorders.host.record({ kind: "working" }, out).catch((error: Error) => error.message);

    expect(failure?.split("\n")[0]).toMatch(/^no recording was written \(runshape-go exited with 1, and left no latest\.json\); the end of .*run\.log:$/);
  });

  test("runshape.json's recorder section is read beside the zones; a file that isn't JSON, or a project that can't be told, records nothing and says why", async () => {
    const declared = mkdtempSync(join(tmpdir(), "runshape-project-"));
    writeFileSync(join(declared, "package.json"), "{}");
    writeFileSync(join(declared, "runshape.json"), JSON.stringify({ version: 2, style: "hexagonal", zones: [], recorder: { language: "python", tests: ["tests"] } }));
    const broken = mkdtempSync(join(tmpdir(), "runshape-project-"));
    writeFileSync(join(broken, "runshape.json"), "{ not json");
    const untold = new UnchosenRecorder(new TestConfigError(["nothing at the project's root says its language"]));

    expect({
      declared: await projectTestConfig(declared, null),
      broken: await projectTestConfig(broken, null).catch((error: TestConfigError) => error.problems[0]!.split(":")[0]),
      untold: await untold.record({ kind: "working" }, declared).catch((error: Error) => error.message),
    }).toEqual({
      declared: { language: "python", chosenBy: "runshape.json", source: [], tests: ["tests"], args: [], interpreter: null },
      broken: "runshape.json isn't valid JSON",
      untold: "can't tell how to record this project:\n  - nothing at the project's root says its language",
    });
  });
});
