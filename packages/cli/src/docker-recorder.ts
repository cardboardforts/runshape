// Records a commit in a container: someone else's (or an agent's) tests get the commit,
// read-only, and an output folder, and nothing else of this machine. docs/design.md's threat
// model says why each step is here; docker-recorder.test.ts pins them.
import { spawn } from "node:child_process";
import { chmod, lstat, readdir, readFile, rm } from "node:fs/promises";
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
const IMAGE_NAME = "runshape-recorder";
/** No file a recording writes is this big, nor the recording as a whole: past it, it's filling the disk. */
const MAX_FILE_BYTES = 1024 ** 3;
const MAX_RECORDING_BYTES = 2 * 1024 ** 3;
/** The only place lockfile entries may come from: anything else (git, a tarball URL, a path) can run code at install. */
const NPM_REGISTRY = "https://registry.npmjs.org/";
/** node:*-slim's `node` user: for a host that runs as root. */
const UNPRIVILEGED_USER = "1000:1000";
/** npm 7+ lockfiles list every package with where it comes from; older ones don't. */
const MIN_LOCKFILE_VERSION = 2;

export class SandboxRefusal extends Error {}

export class DockerRecorder implements Recorder {
  readonly environment: string;
  /** The host user, so bind-mounted folders stay writable on Linux; never root, even when the host runs as root. */
  readonly user: string;
  private readonly image: string;

  constructor(
    private readonly root: string,
    /** A hash of what the image is built from, in HEAD (recordings.ts sandboxVersion). */
    imageVersion: string,
    private readonly commands: CommandRunner = new SpawnedCommands(),
    user = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
  ) {
    this.image = `${IMAGE_NAME}:${imageVersion}`;
    this.environment = `docker:${this.image}`;
    this.user = user.startsWith("0:") ? UNPRIVILEGED_USER : user;
  }

  async record(target: RecordTarget, outDirectory: string): Promise<void> {
    if (target.kind === "working") throw new SandboxRefusal("--sandbox records commits; the working tree is yours, recorded on this machine without it");
    await this.ensureImage();
    const name = basename(outDirectory);
    const worktree = join(this.root, ".runshape", "worktrees", `sandbox-${name}`);
    await this.cleanUp(worktree);
    await this.git(["worktree", "add", "--detach", "--quiet", worktree, target.commit]);
    let failure: unknown = null;
    try {
      // The commit's own npm settings could name a program to run as git, or a registry: gone.
      await rm(join(worktree, ".npmrc"), { force: true });
      await refuseUnregisteredPackages(worktree);
      // Dependencies: network to fetch them, only the commit mounted, npm's config pinned, no scripts run.
      await this.docker(
        [
          "run", "--name", `runshape-install-${name}`, ...this.hardening(), "--network", "bridge",
          "-e", "npm_config_userconfig=/tmp/no-user-npmrc", "-e", "npm_config_globalconfig=/tmp/no-global-npmrc",
          "-e", "npm_config_ignore_scripts=true", "-e", "npm_config_git=/usr/bin/git",
          "-v", `${worktree}:/target`, "--workdir", "/target", this.image, "npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund",
        ],
        INSTALL_TIMEOUT_MS,
        "installing the commit's dependencies",
      );
      // The tests: no network at all, the commit read-only, the output folder.
      const script = [
        "node_modules/.bin/vitest run --config recorder-ts/vitest.record.config.ts --reporter=default --reporter=json --outputFile.json=/out/run.vitest.json > /out/run.log 2>&1",
        "node recorder-ts/vitest-problems.mjs /out/run/manifest.json /out/run.vitest.json && echo '{\"run\":\"run\"}' > /out/latest.json",
      ].join("; ");
      await this.docker(
        [
          "run", "--name", `runshape-record-${name}`, ...this.hardening(), "--network", "none",
          "-v", `${worktree}:/target:ro`, "-v", `${outDirectory}:/out`,
          // Vite bundles its config next to its install: the one place in the read-only image it writes.
          "--tmpfs", `/runshape/node_modules/.vite-temp:rw,uid=${this.uid()},gid=${this.gid()},size=64m`,
          "-e", "RUNSHAPE_TARGET=/target", "-e", "RUNSHAPE_OUT=/out", "-e", "RUNSHAPE_RUN=run",
          // Vite's and vitest's caches would go in the commit's node_modules, which is read-only.
          "-e", "RUNSHAPE_CACHE=/tmp/runshape-cache",
          "--workdir", "/runshape", this.image, "sh", "-c", script,
        ],
        RECORDING_TIMEOUT_MS,
        "the recording",
      );
      // The container has exited: what it left is checked before anything on this machine reads or writes there.
      await assertPlainFiles(outDirectory);
      await lstat(join(outDirectory, "run", "manifest.json")).catch(() => {
        throw new Error(`no recording was written (its log: ${join(outDirectory, "run.log")})`);
      });
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      try {
        await this.cleanUp(worktree);
      } catch (cleanup) {
        // A cleanup that fails mustn't hide why the recording failed.
        if (failure === null) throw cleanup;
      }
    }
  }

  private hardening(): string[] {
    return [
      "--rm",
      "--user", this.user,
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--read-only",
      "--tmpfs", "/tmp:rw,exec,size=1g",
      "--memory", "4g",
      "--pids-limit", "1024",
      // Per file, on every filesystem including the mounted ones: a test can't write one file to fill the disk.
      "--ulimit", `fsize=${MAX_FILE_BYTES}`,
      "-e", "HOME=/tmp",
    ];
  }

  private uid(): string {
    return this.user.split(":")[0]!;
  }

  private gid(): string {
    return this.user.split(":")[1]!;
  }

  /** Built from HEAD as committed (git archive): nothing uncommitted or untracked gets into it. */
  private async ensureImage(): Promise<void> {
    if ((await this.commands.run("docker", ["image", "inspect", this.image])).code === 0) return;
    const script = 'git -C "$1" archive --format=tar HEAD | docker build --tag "$2" --file recorder-ts/sandbox/Dockerfile -';
    const built = await this.commands.run("sh", ["-c", script, "sh", this.root, this.image]);
    if (built.code !== 0) throw new Error(`building the recorder image failed: ${lastLines(built.output)}`);
  }

  private async docker(args: string[], timeoutMs: number, what: string): Promise<void> {
    const container = args[2]!;
    // One left by a run that was killed outright would make this name taken.
    await this.commands.run("docker", ["rm", "--force", container]);
    const result = await this.commands.run("docker", args, { timeoutMs });
    if (result.signal !== null) {
      // The docker client stopping doesn't stop its container.
      await this.commands.run("docker", ["kill", container]);
      throw new Error(`${what} ran out of time (${timeoutMs / 60_000} minutes) and was stopped`);
    }
    if (result.code !== 0) throw new Error(`${what} failed (exit ${result.code}): ${lastLines(result.output)}`);
  }

  /** Removes the worktree even if the commit's tests broke its .git file, which `git worktree remove` would refuse. */
  private async cleanUp(worktree: string): Promise<void> {
    await removeAnyway(worktree);
    await this.git(["worktree", "prune"]);
  }

  private async git(args: string[]): Promise<void> {
    const result = await this.commands.run("git", ["-C", this.root, ...args]);
    if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.output.trim()}`);
  }
}

/** A lockfile entry from anywhere but the registry (git, a URL, a path) can run code as npm installs it. */
async function refuseUnregisteredPackages(worktree: string): Promise<void> {
  const text = await readFile(join(worktree, "package-lock.json"), "utf8").catch(() => null);
  if (text === null) throw new SandboxRefusal("the commit has no package-lock.json: its dependencies can't be installed as locked");
  const lock = JSON.parse(text) as { lockfileVersion?: number; packages?: Record<string, { resolved?: string; link?: boolean; inBundle?: boolean }> };
  // Without `packages` npm resolves dependencies itself, past anything checked here.
  if ((lock.lockfileVersion ?? 0) < MIN_LOCKFILE_VERSION || typeof lock.packages !== "object" || lock.packages === null) {
    throw new SandboxRefusal("its lockfile isn't one npm 7+ writes (lockfileVersion 2 or 3, with packages): its dependencies can't be checked before installing");
  }
  // Every package says where it comes from: the registry. One that doesn't is resolved by npm, from anywhere.
  const outside = Object.entries(lock.packages)
    .filter(([path, entry]) => path !== "" && !entry.link && !entry.inBundle && (entry.resolved === undefined || !entry.resolved.startsWith(NPM_REGISTRY)))
    .map(([path, entry]) => `${path} (${entry.resolved ?? "no resolved URL"})`);
  if (outside.length > 0) throw new SandboxRefusal(`its lockfile installs from outside the npm registry, which can run code at install: ${outside.slice(0, 3).join(", ")}`);
}

/**
 * Every entry the recording left is a plain file or folder, and they add up to a sane size: a
 * link would turn the host's next write or read there into one somewhere else.
 */
export async function assertPlainFiles(directory: string): Promise<void> {
  try {
    await walkPlainFiles(directory);
  } catch (error) {
    if (error instanceof SandboxRefusal) throw error;
    // A folder the tests made unreadable (chmod 000), say: refused, not a crash.
    throw new SandboxRefusal(`the recording left something it can't read (${error instanceof Error ? error.message : String(error)}): not used`);
  }
}

async function walkPlainFiles(directory: string): Promise<void> {
  let total = 0;
  const walk = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) total += (await lstat(full)).size;
      else throw new SandboxRefusal(`the recording left ${full.slice(directory.length + 1)}, which isn't a plain file (a link?): not used`);
      if (total > MAX_RECORDING_BYTES) throw new SandboxRefusal(`the recording wrote over ${MAX_RECORDING_BYTES / 1024 ** 3} GB: not used`);
    }
  };
  await walk(directory);
}

/**
 * Removes a folder whatever the commit's tests did to it: a folder they made unreadable (chmod
 * 000, owned by the person, so fixable) would otherwise stop every later run. Links are removed,
 * never followed.
 */
export async function removeAnyway(path: string): Promise<void> {
  const entry = await lstat(path).catch(() => null);
  if (entry === null) return;
  if (entry.isDirectory()) {
    await chmod(path, 0o700).catch(() => {});
    for (const name of await readdir(path).catch(() => [] as string[])) await removeAnyway(join(path, name));
  }
  await rm(path, { recursive: true, force: true });
}

function lastLines(output: string): string {
  return output.trim().split("\n").slice(-5).join("\n");
}

/** Keeps the last of what a command printed, and shows it as it goes: an image build takes minutes. */
const KEPT_OUTPUT = 8 * 1024;

class SpawnedCommands implements CommandRunner {
  run(command: string, args: string[], options: { timeoutMs?: number } = {}): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], timeout: options.timeoutMs });
      let output = "";
      const keep = (chunk: Buffer) => {
        const quiet = (command === "docker" && ["image", "rm", "kill"].includes(args[0]!)) || command === "git";
        if (!quiet) process.stderr.write(chunk);
        output = (output + chunk.toString()).slice(-KEPT_OUTPUT);
      };
      child.stdout.on("data", keep);
      child.stderr.on("data", keep);
      child.on("error", reject);
      child.on("close", (code, signal) => resolve({ code, signal, output }));
    });
  }
}
