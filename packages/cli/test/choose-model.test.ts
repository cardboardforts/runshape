/**
 * Which model `--explain` and `--describe` ask when the person doesn't say: their own
 * `claude -p` if it runs, else the API if a key is set; and what to do when neither is there.
 */
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { chooseModel } from "../src/choose-model";

/** A `claude` that answers --version, as an installed one does. */
function standInClaude(script: string): { command: string } {
  const directory = mkdtempSync(join(tmpdir(), "runshape-claude-"));
  const command = join(directory, "claude");
  writeFileSync(command, `#!/bin/sh\n${script}\n`);
  chmodSync(command, 0o755);
  return { command };
}

describe("chooseModel", () => {
  test("claude -p when it runs, else the API when a key is set, else what to do", async () => {
    const { command } = standInClaude('echo "2.1.301 (Claude Code)"');

    const names = await Promise.all([
      chooseModel("auto", { RUNSHAPE_CLAUDE: command }),
      chooseModel("auto", { RUNSHAPE_CLAUDE: "/nowhere/claude", ANTHROPIC_API_KEY: "sk-x" }),
      chooseModel("auto", { RUNSHAPE_CLAUDE: "/nowhere/claude" }).catch((error: Error) => error.message),
      chooseModel("api", {}).catch((error: Error) => error.message),
    ]);

    expect(names.map((m) => (typeof m === "string" ? m : m.name))).toEqual([
      "claude-cli",
      "anthropic:claude-sonnet-5-5",
      "no language model: install the claude command (or point RUNSHAPE_CLAUDE at it), or set ANTHROPIC_API_KEY",
      "the API model (=api) needs ANTHROPIC_API_KEY",
    ]);
  });
});
