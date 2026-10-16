/**
 * Recording a commit in a container: someone else's (or an agent's) tests, run unattended,
 * get the PR's code and an output folder, and nothing else of this machine (docs/design.md,
 * threat model). What matters is what's handed to docker, so that's what's checked, flag by
 * flag, with the commands faked. A real recording runs it for real (npm run runshape -- record
 * <ref> --sandbox).
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { CommandResult, CommandRunner, DockerRecorder } from "../src/docker-recorder";

class FakeCommands implements CommandRunner {
  readonly calls: string[][] = [];
  constructor(private readonly answer: (command: string, args: string[]) => CommandResult = () => ({ code: 0, signal: null, output: "" })) {}
  async run(command: string, args: string[]): Promise<CommandResult> {
    this.calls.push([command, ...args]);
    return this.answer(command, args);
  }
}

function setup(answer?: (command: string, args: string[]) => CommandResult) {
  const root = mkdtempSync(join(tmpdir(), "runshape-docker-"));
  const out = join(root, ".runshape", "recordings", ".incoming-abc");
  mkdirSync(out, { recursive: true });
  const commands = new FakeCommands((command, args) => {
    // The recording container writes the manifest the recorder looks for.
    if (command === "docker" && args[0] === "run" && args.includes("none")) {
      mkdirSync(join(out, "run"), { recursive: true });
      writeFileSync(join(out, "run", "manifest.json"), "{}");
    }
    return answer?.(command, args) ?? { code: 0, signal: null, output: "" };
  });
  return { root, out, commands, recorder: new DockerRecorder(root, "0123456789abcdef", commands) };
}

describe("DockerRecorder", () => {
  test("builds the recorder image once, installs the commit's dependencies without scripts, records it with no network", async () => {
    const { root, out, commands, recorder } = setup((command, args) => (args[0] === "image" ? { code: 1, signal: null, output: "No such image" } : null) as never);
    const worktree = join(root, ".runshape", "worktrees", "sandbox-.incoming-abc");

    await recorder.record({ kind: "commit", commit: "c0ffee0000000000000000000000000000000000" }, out);

    const hardening = ["--rm", "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only", "--tmpfs", "/tmp:rw,exec,size=1g", "--memory", "4g", "--pids-limit", "1024", "-e", "HOME=/tmp"];
    expect(commands.calls.map((call) => call.map((arg) => arg.replace(root, "<root>")))).toEqual([
      ["docker", "image", "inspect", "runshape-recorder:0123456789abcdef"],
      ["docker", "build", "--tag", "runshape-recorder:0123456789abcdef", "--file", "<root>/recorder-ts/sandbox/Dockerfile", "<root>"],
      ["git", "-C", "<root>", "worktree", "prune"],
      ["git", "-C", "<root>", "worktree", "add", "--detach", "--quiet", worktree.replace(root, "<root>"), "c0ffee0000000000000000000000000000000000"],
      // Dependencies: network to fetch them, nothing else mounted, no scripts run.
      ["docker", "run", "--name", "runshape-install-.incoming-abc", ...hardening, "--network", "bridge", "-v", `${worktree.replace(root, "<root>")}:/target`, "--workdir", "/target", "runshape-recorder:0123456789abcdef", "npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"],
      // The tests: no network, the commit and the output folder, nothing else.
      [
        "docker", "run", "--name", "runshape-record-.incoming-abc", ...hardening, "--network", "none",
        "-v", `${worktree.replace(root, "<root>")}:/target`, "-v", `${out.replace(root, "<root>")}:/out`,
        "-e", "RUNSHAPE_TARGET=/target", "-e", "RUNSHAPE_OUT=/out", "-e", "RUNSHAPE_RUN=run",
        "--tmpfs", "/runshape/node_modules/.vite-temp:rw,uid=1000,gid=1000,size=64m",
        "--workdir", "/runshape", "runshape-recorder:0123456789abcdef",
        "sh", "-c",
        "node_modules/.bin/vitest run --config recorder-ts/vitest.record.config.ts --reporter=default --reporter=json --outputFile.json=/out/run.vitest.json > /out/run.log 2>&1; node recorder-ts/vitest-problems.mjs /out/run/manifest.json /out/run.vitest.json && echo '{\"run\":\"run\"}' > /out/latest.json",
      ],
      ["git", "-C", "<root>", "worktree", "remove", "--force", worktree.replace(root, "<root>")],
    ]);
  });

  test("the working tree isn't sandboxed: it's your own code, recorded on this machine", async () => {
    const { out, recorder } = setup();

    await expect(recorder.record({ kind: "working" }, out)).rejects.toThrowError("--sandbox records commits; the working tree is yours, recorded on this machine without it");
  });

  test("a recording that runs out of time is killed, and its worktree removed, and says so", async () => {
    const { root, out, commands, recorder } = setup((command, args) => (command === "docker" && args[0] === "run" && args.includes("none") ? { code: null, signal: "SIGTERM", output: "" } : null) as never);

    await expect(recorder.record({ kind: "commit", commit: "c0ffee" }, out)).rejects.toThrowError("the recording ran out of time (20 minutes) and was stopped");
    expect(commands.calls.slice(-2).map((call) => call.slice(0, 3).join(" ").replace(root, "<root>"))).toEqual(["docker kill runshape-record-.incoming-abc", "git -C <root>"]);
  });

  test("its environment names the image: recordings made in another one are recorded again before comparing", () => {
    expect(setup().recorder.environment).toBe("docker:runshape-recorder:0123456789abcdef");
  });
});
