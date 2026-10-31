// Every test run gets one temporary folder, removed when the run ends. Tests make real git
// repositories and recordings under os.tmpdir(); nothing removed them, and 25,000 left over
// slowed every file operation on the machine until test runs timed out (2026-10-31).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default function setup(): () => void {
  const run = mkdtempSync(join(tmpdir(), "runshape-tests-"));
  // The workers start after this, with this environment: their os.tmpdir() is the run's folder.
  process.env.TMPDIR = run;
  return () => rmSync(run, { recursive: true, force: true });
}
