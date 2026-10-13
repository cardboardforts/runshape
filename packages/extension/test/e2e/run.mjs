// End-to-end: launch an isolated VS Code (downloaded into .vscode-test, separate from any
// installed one) on the recorded Django example, open the Runshape view, then read the
// extension's own structured log to prove the whole loop ran: extension activated, webview
// script executed under its CSP and asked for data, the core answered.
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runTests } from "@vscode/test-electron";

// Set when this runs from a VS Code terminal; it would make the downloaded VS Code start as
// plain Node instead of an editor.
delete process.env.ELECTRON_RUN_AS_NODE;

const here = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(here, "..", "..");
const workspace = resolve(extensionRoot, "..", "..", "examples", "django-realworld");
const userDataDir = resolve(extensionRoot, ".vscode-test", "user-data");
const fakeModel = join(here, "fake-model");
const modelLog = resolve(extensionRoot, ".vscode-test", "fake-model-prompts.jsonl");

await rm(userDataDir, { recursive: true, force: true });
await rm(modelLog, { force: true });
// A declared zone, so the run proves runshape.json is read; removed afterwards.
const rulesFile = join(workspace, "runshape.json");
await writeFile(rulesFile, JSON.stringify({ version: 2, style: "hexagonal", zones: [{ match: "conduit.apps.*.models.*", zone: "core", reason: "e2e" }] }));
try {
  await runTests({
    // Runshape plus a fake language model, so "suggest a zone" runs through the real API.
    extensionDevelopmentPath: [extensionRoot, fakeModel],
    extensionTestsPath: join(here, "suite.cjs"),
    extensionTestsEnv: { RUNSHAPE_FAKE_MODEL_LOG: modelLog },
    launchArgs: [workspace, "--disable-extensions", `--user-data-dir=${userDataDir}`, "--skip-welcome", "--skip-release-notes"],
  });
} finally {
  await rm(rulesFile, { force: true });
}

const log = await readRunshapeLog(join(userDataDir, "logs"));
const expected = [
  "event=extension.activated",
  "event=panel.opened",
  "event=webview.request request=1 type=ready",
  "event=run.loaded",
  "framework=django",
  "rules=1",
  "event=webview.request request=2 type=graph",
  "event=webview.response request=2 type=graph",
];
expected.push("event=command.suggest_zone", "event=advice.requested model=runshape-fake-1", "event=advice.received model=runshape-fake-1");
const missing = expected.filter((needle) => !log.includes(needle));
const failures = log.split("\n").filter((line) => line.includes("event=webview.failed") || line.includes(".failed "));
// The model must have been sent the component's recorded evidence and its source.
const prompts = (await readFile(modelLog, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
if (prompts.length !== 1) failures.push(`fake model received ${prompts.length} prompts, expected 1`);
for (const needle of ["conduit.apps.articles.views.ArticleViewSet", "Called by", "class ArticleViewSet"]) {
  if (!prompts[0]?.includes(needle)) failures.push(`prompt is missing ${JSON.stringify(needle)}`);
}

// The webview's first requests arrive together; they must share a single load.
const loads = log.split("\n").filter((line) => line.includes("event=run.loaded")).length;
if (loads !== 1) failures.push(`run.loaded ${loads} times, expected once`);
console.log("---- Runshape log ----\n" + log.trim() + "\n--------------------");
if (missing.length > 0 || failures.length > 0) {
  console.error(`missing: ${JSON.stringify(missing)}\nfailures: ${JSON.stringify(failures)}`);
  process.exit(1);
}
console.log("e2e: extension, webview and core talked end to end");

async function readRunshapeLog(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name === "Runshape.log") {
      return readFile(join(entry.parentPath ?? entry.path, entry.name), "utf8");
    }
  }
  throw new Error(`no Runshape.log under ${directory}`);
}
