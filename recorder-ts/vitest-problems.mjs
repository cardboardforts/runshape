// node vitest-problems.mjs <manifest.json> <vitest json report>
// Tests that never reached a scenario are missing from the recording, which reads as "removed"
// in a comparison. Say so in the manifest's sessionProblems: test files that failed to load,
// and tests vitest skipped.
import { readFileSync, writeFileSync } from "node:fs";
import { relative } from "node:path";

const [manifestPath, reportPath] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const report = JSON.parse(readFileSync(reportPath, "utf8"));
const problems = [];
let skipped = 0;
for (const file of report.testResults ?? []) {
  const name = relative(manifest.root, file.name);
  if (file.status === "failed" && (file.assertionResults ?? []).length === 0) {
    problems.push(`${name} failed to run, so none of its tests are in this recording: ${(file.message ?? "").split("\n")[0]}`);
  }
  skipped += (file.assertionResults ?? []).filter((test) => ["skipped", "pending", "todo"].includes(test.status)).length;
}
if (skipped > 0) problems.push(`${skipped} skipped tests are not in this recording`);
manifest.sessionProblems = [...(manifest.sessionProblems ?? []), ...problems];
writeFileSync(manifestPath, JSON.stringify(manifest));
for (const problem of problems) console.log(`self-review: ${problem}`);
