// End-to-end: launch an isolated VS Code (downloaded into .vscode-test, separate from any
// installed one) on the recorded Django example, open the HexVis view, then read the
// extension's own structured log to prove the whole loop ran: extension activated, webview
// script executed under its CSP and asked for data, the core answered.
import { readdir, readFile, rm } from "node:fs/promises";
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

await rm(userDataDir, { recursive: true, force: true });
await runTests({
  extensionDevelopmentPath: extensionRoot,
  extensionTestsPath: join(here, "suite.cjs"),
  launchArgs: [workspace, "--disable-extensions", `--user-data-dir=${userDataDir}`, "--skip-welcome", "--skip-release-notes"],
});

const log = await readHexvisLog(join(userDataDir, "logs"));
const expected = [
  "event=extension.activated",
  "event=panel.opened",
  "event=webview.request request=1 type=ready",
  "event=run.loaded",
  "framework=django",
  "event=webview.request request=2 type=graph",
  "event=webview.response request=2 type=graph",
];
const missing = expected.filter((needle) => !log.includes(needle));
const failures = log.split("\n").filter((line) => line.includes("event=webview.failed"));
// The webview's first requests arrive together; they must share a single load.
const loads = log.split("\n").filter((line) => line.includes("event=run.loaded")).length;
if (loads !== 1) failures.push(`run.loaded ${loads} times, expected once`);
console.log("---- HexVis log ----\n" + log.trim() + "\n--------------------");
if (missing.length > 0 || failures.length > 0) {
  console.error(`missing: ${JSON.stringify(missing)}\nfailures: ${JSON.stringify(failures)}`);
  process.exit(1);
}
console.log("e2e: extension, webview and core talked end to end");

async function readHexvisLog(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name === "HexVis.log") {
      return readFile(join(entry.parentPath ?? entry.path, entry.name), "utf8");
    }
  }
  throw new Error(`no HexVis.log under ${directory}`);
}
