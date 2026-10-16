// Records a commit in a container: someone else's (or an agent's) tests get the commit and an
// output folder, and nothing else of this machine. docs/design.md's threat model says why each
// flag is here; docker-recorder.test.ts pins them.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";

import { Recorder, RecordTarget } from "./recordings";

export interface CommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** The end of what it printed, for an error message. */
  output: string;
}

/** Port: runs a command, its arguments passed as they are (never through a shell). */
export interface CommandRunner {
  run(command: string, args: string[], options?: { timeoutMs?: number }): Promise<CommandResult>;
}

/** One commit's install and tests: past this, something's stuck (and gets killed). */
const RECORDING_TIMEOUT_MS = 20 * 60_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;
/** The user the recorder image runs as (node:*-slim's `node`): never root. */
const SANDBOX_USER = "1000:1000";
const IMAGE_NAME = "runshape-recorder";
const VITE_TEMP = `/runshape/node_modules/.vite-temp:rw,uid=1000,gid=1000,size=64m`;

/** Every container, install and recording alike: no root, no capabilities, nothing writable but /tmp and what's mounted. */
const HARDENING = [
  "--rm",
  "--user", SANDBOX_USER,
  "--cap-drop", "ALL",
  "--security-opt", "no-new-privileges",
  "--read-only",
  "--tmpfs", "/tmp:rw,exec,size=1g",
  "--memory", "4g",
  "--pids-limit", "1024",
  "-e", "HOME=/tmp",
];

export class DockerRecorder implements Recorder {
  readonly environment: string;
  private readonly image: string;

  constructor(
    private readonly root: string,
    /** A hash of the recorder's source and lockfile: a new one builds a new image. */
    recorderVersion: string,
    private readonly commands: CommandRunner = new SpawnedCommands(),
  ) {
    this.image = `${IMAGE_NAME}:${recorderVersion}`;
    this.environment = `docker:${this.image}`;
  }

  async record(target: RecordTarget, outDirectory: string): Promise<void> {
    if (target.kind === "working") throw new Error("--sandbox records commits; the working tree is yours, recorded on this machine without it");
    await this.ensureImage();
    const name = basename(outDirectory);
    const worktree = join(this.root, ".runshape", "worktrees", `sandbox-${name}`);
    await this.git(["worktree", "prune"]);
    await this.git(["worktree", "add", "--detach", "--quiet", worktree, target.commit]);
    try {
      // Dependencies: network to fetch them, only the commit mounted, no install scripts run.
      await this.docker(
        ["run", "--name", `runshape-install-${name}`, ...HARDENING, "--network", "bridge", "-v", `${worktree}:/target`, "--workdir", "/target", this.image, "npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"],
        INSTALL_TIMEOUT_MS,
        "installing the commit's dependencies",
      );
      // The tests: no network at all, the commit and the output folder.
      const script = [
        "node_modules/.bin/vitest run --config recorder-ts/vitest.record.config.ts --reporter=default --reporter=json --outputFile.json=/out/run.vitest.json > /out/run.log 2>&1",
        "node recorder-ts/vitest-problems.mjs /out/run/manifest.json /out/run.vitest.json && echo '{\"run\":\"run\"}' > /out/latest.json",
      ].join("; ");
      await this.docker(
        [
          "run", "--name", `runshape-record-${name}`, ...HARDENING, "--network", "none",
          "-v", `${worktree}:/target`, "-v", `${outDirectory}:/out`,
          "-e", "RUNSHAPE_TARGET=/target", "-e", "RUNSHAPE_OUT=/out", "-e", "RUNSHAPE_RUN=run",
          // Vite bundles its config next to its install: the one place in the read-only image it writes.
          "--tmpfs", VITE_TEMP,
          "--workdir", "/runshape", this.image, "sh", "-c", script,
        ],
        RECORDING_TIMEOUT_MS,
        "the recording",
      );
      // Failing tests are recorded like passing ones; a recording with no manifest is not.
      if (!existsSync(join(outDirectory, "run", "manifest.json"))) throw new Error(`no recording was written (its log: ${join(outDirectory, "run.log")})`);
    } finally {
      await this.git(["worktree", "remove", "--force", worktree]);
    }
  }

  private async ensureImage(): Promise<void> {
    if ((await this.commands.run("docker", ["image", "inspect", this.image])).code === 0) return;
    const built = await this.commands.run("docker", ["build", "--tag", this.image, "--file", join(this.root, "recorder-ts", "sandbox", "Dockerfile"), this.root]);
    if (built.code !== 0) throw new Error(`building the recorder image failed: ${built.output.trim().split("\n").slice(-5).join("\n")}`);
  }

  private async docker(args: string[], timeoutMs: number, what: string): Promise<void> {
    const result = await this.commands.run("docker", args, { timeoutMs });
    if (result.signal !== null) {
      // The docker client stopping doesn't stop its container.
      await this.commands.run("docker", ["kill", args[2]!]);
      throw new Error(`${what === "the recording" ? "the recording" : what} ran out of time (${timeoutMs / 60_000} minutes) and was stopped`);
    }
    if (result.code !== 0) throw new Error(`${what} failed (exit ${result.code}): ${result.output.trim().split("\n").slice(-5).join("\n")}`);
  }

  private async git(args: string[]): Promise<void> {
    const result = await this.commands.run("git", ["-C", this.root, ...args]);
    if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.output.trim()}`);
  }
}

/** Keeps the last of what a command printed, and shows it as it goes: an image build takes minutes. */
const KEPT_OUTPUT = 8 * 1024;

class SpawnedCommands implements CommandRunner {
  run(command: string, args: string[], options: { timeoutMs?: number } = {}): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], timeout: options.timeoutMs });
      let output = "";
      const keep = (chunk: Buffer) => {
        if (command === "docker" && args[0] !== "image") process.stderr.write(chunk);
        output = (output + chunk.toString()).slice(-KEPT_OUTPUT);
      };
      child.stdout.on("data", keep);
      child.stderr.on("data", keep);
      child.on("error", reject);
      child.on("close", (code, signal) => resolve({ code, signal, output }));
    });
  }
}
