// Records a commit in a container: someone else's (or an agent's) tests get the commit,
// read-only, and an output folder, and nothing else of this machine. docs/design.md's threat
// model says why each step is here; docker-recorder.test.ts pins them. What differs by
// language (the image, the checks before installing, the install, the test run) is a
// SandboxRecipe, one per recorder (typescript/, python/, go/).
import { spawn } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { assertPlainFiles, NotPlainFiles, removeAnyway } from "@runshape/infra";

import { Hashing, Recorder, RecorderLanguage, RecordTarget, Repository, VERSION_DIGITS } from "@runshape/kernel";

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
/** No file a recording writes is this big, nor the recording as a whole: past it, it's filling the disk. */
const MAX_FILE_BYTES = 1024 ** 3;
const MAX_RECORDING_BYTES = 2 * 1024 ** 3;
/** node:*-slim's `node` user: for a host that runs as root. */
const UNPRIVILEGED_USER = "1000:1000";
/** Containers runshape starts: any still there when a run begins was left by one killed outright. */
const LEFTOVER_PREFIXES = ["runshape-install-", "runshape-proxy-", "runshape-record-"];
/** Where recorder-ts/sandbox/registry-proxy.mjs listens; every image carries it, and node to run it. */
const PROXY_PORT = 3128;
const PROXY_COMMAND = ["node", "recorder-ts/sandbox/registry-proxy.mjs"];
/** Where every image keeps the recorder: the proxy's path, and the record step's workdir, are relative to it. */
const RECORDER_HOME = "/runshape";

export class SandboxRefusal extends Error {}

/** A container's command and what it's given: arguments as they are, never a shell line built from the commit. */
export interface ContainerStep {
  /** docker run's options for this step: -e and --tmpfs. */
  options: string[];
  workdir: string;
  command: string[];
}

/** What a language's sandbox does differently: its image, its checks, its install and its test run. */
export interface SandboxRecipe {
  readonly language: RecorderLanguage;
  /** The image's name; its tag is its version (sandboxVersion). */
  readonly image: string;
  /** Its Dockerfile, in Runshape's checkout. */
  readonly dockerfile: string;
  /** What the image is built from: a change to any of them, in HEAD, builds a new one. */
  readonly imageSources: string[];
  /** The hosts ("name:443") the registry proxy lets the install reach; null: the proxy's own (npm's registry). */
  readonly registries: string[] | null;
  /** The checks on the commit's own files before anything installs (SandboxRefusal), and what's taken out of it. */
  prepare(worktree: string): Promise<void>;
  /** The dependencies, into the commit's folder (/target, writable), through the proxy. */
  install(proxy: string): ContainerStep;
  /** The tests, with /target read-only, /out for the recording, and no network. */
  record(): ContainerStep;
}

/**
 * Folders the install makes inside the commit (its venv, its module cache): one the commit
 * already has is the commit's, and would be used as it is, so nothing is installed.
 */
export async function refuseCommitted(worktree: string, names: string[]): Promise<void> {
  for (const name of names) {
    if (await lstat(join(worktree, name)).then(() => true, () => false)) throw new SandboxRefusal(`the commit has its own ${name}, where the install puts what it fetches: not used, so not installed`);
  }
}

/**
 * A file of the commit's the host reads before installing: a plain file, links not followed
 * (one pointing at ~/.ssh/id_rsa would put that in a refusal and the log).
 */
export async function readPlainFile(worktree: string, name: string, missing: string): Promise<string> {
  const entry = await lstat(join(worktree, name)).catch(() => null);
  if (entry === null) throw new SandboxRefusal(missing);
  if (!entry.isFile()) throw new SandboxRefusal(`the commit's ${name} isn't a plain file (a link?): not read`);
  return readFile(join(worktree, name), "utf8");
}

/** The image's version: what HEAD has at each of its sources (a path HEAD hasn't got counts too). */
export async function sandboxVersion(repository: Repository, hashing: Hashing, recipe: SandboxRecipe): Promise<string> {
  const hash = hashing.digest();
  for (const path of recipe.imageSources) hash.update(path).update("\0").update((await repository.objectAtHead(path)) ?? "absent").update("\0");
  return hash.hex().slice(0, VERSION_DIGITS);
}

/** What every recording leaves, whatever the language: the pointer to its run, and the run's manifest. */
const EXPECTED = [join("run", "manifest.json"), "latest.json"];

export class DockerRecorder implements Recorder {
  readonly environment: string;
  /** The host user, so bind-mounted folders stay writable on Linux; never root, even when the host runs as root. */
  readonly user: string;
  private readonly image: string;

  constructor(
    /** Runshape's checkout: the image is built from its HEAD. */
    private readonly home: string,
    /** The project's root: the commit is checked out from it. */
    private readonly root: string,
    private readonly recipe: SandboxRecipe,
    /** A hash of what the image is built from, in HEAD (sandboxVersion, above). */
    private readonly imageVersion: string,
    private readonly commands: CommandRunner = new SpawnedCommands(),
    user = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
  ) {
    this.image = `${recipe.image}:${imageVersion}`;
    this.environment = `docker:${this.image}`;
    this.user = user.startsWith("0:") ? UNPRIVILEGED_USER : user;
  }

  /** What the image is built from: its version is its source. */
  async source(): Promise<string> {
    return this.imageVersion;
  }

  async record(target: RecordTarget, outDirectory: string): Promise<void> {
    if (target.kind === "working") throw new SandboxRefusal("--sandbox records commits; the working tree is yours, recorded on this machine without it");
    await this.ensureImage();
    await this.sweepLeftovers();
    const name = basename(outDirectory);
    const worktree = join(this.root, ".runshape", "worktrees", `sandbox-${name}`);
    await this.cleanUp(worktree);
    await this.git(["worktree", "add", "--detach", "--quiet", worktree, target.commit]);
    let failure: unknown = null;
    try {
      await this.recipe.prepare(worktree);
      // Dependencies: only the commit mounted, the installer's config pinned, nothing of theirs
      // run, and no way out but the registry proxy: whatever the commit asks for, nothing else
      // can be fetched.
      await this.withRegistryOnlyNetwork(name, async (network, proxy) => {
        const install = this.recipe.install(proxy);
        await this.docker(
          ["run", "--name", `runshape-install-${name}`, ...this.hardening(), "--network", network, ...install.options, "-v", `${worktree}:/target`, "--workdir", install.workdir, this.image, ...install.command],
          INSTALL_TIMEOUT_MS,
          "installing the commit's dependencies",
        );
      });
      // The tests: no network at all, the commit read-only, the output folder.
      const record = this.recipe.record();
      const options = record.options.map((option) => option.replace("{uid}", this.uid()).replace("{gid}", this.gid()));
      await this.docker(
        ["run", "--name", `runshape-record-${name}`, ...this.hardening(), "--network", "none", "-v", `${worktree}:/target:ro`, "-v", `${outDirectory}:/out`, ...options, "--workdir", record.workdir, this.image, ...record.command],
        RECORDING_TIMEOUT_MS,
        "the recording",
      );
      // The container has exited: what it left is checked before anything on this machine reads or writes there.
      await assertPlainRecording(outDirectory);
      for (const file of EXPECTED) {
        await lstat(join(outDirectory, file)).catch(() => {
          throw new Error(`no recording was written (no ${file}; its log: ${join(outDirectory, "run.log")})`);
        });
      }
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

  /**
   * An internal network (no route anywhere) whose one other member is the registry proxy, which
   * alone also sits on a network with a way out; both removed afterwards.
   */
  private async withRegistryOnlyNetwork(name: string, install: (network: string, proxy: string) => Promise<void>): Promise<void> {
    const network = `runshape-install-${name}`;
    const proxyName = `runshape-proxy-${name}`;
    // inhibit_ipv4: the bridge gets no address of its own, so the network's gateway isn't this
    // machine answering (sshd, a dev database); --internal alone leaves that reachable.
    await this.checked(["network", "create", "--internal", "-o", "com.docker.network.bridge.inhibit_ipv4=true", network], "making the install's network");
    try {
      const allow = this.recipe.registries === null ? [] : ["-e", `RUNSHAPE_PROXY_ALLOW=${this.recipe.registries.join(",")}`];
      await this.checked(
        ["run", "--detach", "--name", proxyName, ...this.hardening(), "--network", "bridge", ...allow, "--workdir", RECORDER_HOME, this.image, ...PROXY_COMMAND],
        "starting the registry proxy",
      );
      await this.checked(["network", "connect", network, proxyName], "connecting the registry proxy");
      await install(network, `http://${proxyName}:${PROXY_PORT}`);
    } finally {
      await this.commands.run("docker", ["rm", "--force", `runshape-install-${name}`]);
      await this.commands.run("docker", ["rm", "--force", proxyName]);
      await this.commands.run("docker", ["network", "rm", network]);
    }
  }

  /**
   * What a run killed outright left (an install still running, a proxy, the network they held):
   * nothing else records while the lock is held, so every one of them is a leftover.
   */
  private async sweepLeftovers(): Promise<void> {
    const containers = (await this.commands.run("docker", ["ps", "--all", "--format", "{{.Names}}"])).output.split("\n").map((n) => n.trim());
    for (const container of containers.filter((n) => LEFTOVER_PREFIXES.some((prefix) => n.startsWith(prefix)))) await this.commands.run("docker", ["rm", "--force", container]);
    const networks = (await this.commands.run("docker", ["network", "ls", "--format", "{{.Name}}"])).output.split("\n").map((n) => n.trim());
    for (const network of networks.filter((n) => n.startsWith("runshape-install-"))) await this.commands.run("docker", ["network", "rm", network]);
  }

  private async checked(args: string[], what: string): Promise<void> {
    const result = await this.commands.run("docker", args);
    if (result.code !== 0) throw new Error(`${what} failed: ${lastLines(result.output)}`);
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
    const script = 'git -C "$1" archive --format=tar HEAD | docker build --tag "$2" --file "$3" -';
    const built = await this.commands.run("sh", ["-c", script, "sh", this.home, this.image, this.recipe.dockerfile]);
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

/**
 * Every entry the recording left is a plain file or folder, and they add up to a sane size: a
 * link would turn the host's next write or read there into one somewhere else.
 */
export async function assertPlainRecording(directory: string): Promise<void> {
  try {
    await assertPlainFiles(directory, MAX_RECORDING_BYTES);
  } catch (error) {
    if (!(error instanceof NotPlainFiles)) throw error;
    if (error.reason === "not-a-file") throw new SandboxRefusal(`the recording left ${error.detail}, which isn't a plain file (a link?): not used`);
    if (error.reason === "too-big") throw new SandboxRefusal(`the recording wrote over ${MAX_RECORDING_BYTES / 1024 ** 3} GB: not used`);
    throw new SandboxRefusal(`the recording left something it can't read (${error.detail}): not used`);
  }
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
