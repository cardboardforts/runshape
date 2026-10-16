/**
 * Recording a commit in a container: someone else's (or an agent's) tests, run unattended,
 * get the commit (read-only) and an output folder, and nothing else of this machine
 * (docs/design.md, threat model). What's handed to docker is checked flag by flag with the
 * commands faked; the checks the host makes itself (the commit's npm settings, its lockfile,
 * what the recording left behind) run on real files. A real recording runs it for real
 * (npm run runshape -- record <ref> --sandbox).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { CommandResult, CommandRunner, DockerRecorder } from "../src/docker-recorder";

const REGISTRY_LOCK = JSON.stringify({ packages: { "": {}, "node_modules/vitest": { resolved: "https://registry.npmjs.org/vitest/-/vitest-5.0.4.tgz" }, "packages/core": { link: true } } });

class FakeCommands implements CommandRunner {
  readonly calls: string[][] = [];
  constructor(private readonly answer: (command: string, args: string[]) => CommandResult | undefined) {}
  async run(command: string, args: string[]): Promise<CommandResult> {
    this.calls.push([command, ...args]);
    return this.answer(command, args) ?? { code: 0, signal: null, output: "" };
  }
}

interface Options {
  lock?: string;
  /** What the recording container leaves in /out. */
  leaves?: (out: string) => void;
  answer?: (command: string, args: string[]) => CommandResult | undefined;
}

function setup({ lock = REGISTRY_LOCK, leaves, answer }: Options = {}) {
  const root = mkdtempSync(join(tmpdir(), "runshape-docker-"));
  const out = join(root, ".runshape", "recordings", ".incoming-abc");
  const worktree = join(root, ".runshape", "worktrees", "sandbox-.incoming-abc");
  mkdirSync(out, { recursive: true });
  const commands = new FakeCommands((command, args) => {
    if (command === "git" && args.includes("add")) {
      // The commit, checked out: with npm settings of its own.
      mkdirSync(join(worktree, "node_modules"), { recursive: true });
      writeFileSync(join(worktree, "package-lock.json"), lock);
      writeFileSync(join(worktree, ".npmrc"), "git=./evil.sh\n");
    }
    if (command === "docker" && args[0] === "run" && args.includes("none")) {
      mkdirSync(join(out, "run"), { recursive: true });
      writeFileSync(join(out, "run", "manifest.json"), "{}");
      leaves?.(out);
    }
    return answer?.(command, args);
  });
  return { root, out, worktree, commands, recorder: new DockerRecorder(root, "0123456789abcdef", commands, "501:20") };
}

const relative = (root: string) => (call: string[]) => call.map((arg) => arg.split(root).join("<root>"));

describe("DockerRecorder", () => {
  test("builds the image from HEAD as committed, installs without the commit's npm settings or scripts, records with no network and the commit read-only", async () => {
    let npmrcAtInstall: boolean | null = null;
    const { root, out, worktree, commands, recorder } = setup({
      answer: (command, args) => {
        if (args[0] === "image") return { code: 1, signal: null, output: "No such image" };
        if (command === "docker" && args.includes("bridge")) npmrcAtInstall = existsSync(join(worktree, ".npmrc"));
        return undefined;
      },
    });

    await recorder.record({ kind: "commit", commit: "c0ffee0000000000000000000000000000000000" }, out);

    const hardening = [
      "--rm", "--user", "501:20", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only",
      "--tmpfs", "/tmp:rw,exec,size=1g", "--memory", "4g", "--pids-limit", "1024", "--ulimit", `fsize=${1024 ** 3}`, "-e", "HOME=/tmp",
    ];
    const tree = "<root>/.runshape/worktrees/sandbox-.incoming-abc";
    expect({ npmrcAtInstall, calls: commands.calls.map(relative(root)) }).toEqual({
      npmrcAtInstall: false,
      calls: [
        ["docker", "image", "inspect", "runshape-recorder:0123456789abcdef"],
        // Only what HEAD commits goes into the image: nothing untracked, nothing uncommitted.
        ["sh", "-c", 'git -C "$1" archive --format=tar HEAD | docker build --tag "$2" --file recorder-ts/sandbox/Dockerfile -', "sh", "<root>", "runshape-recorder:0123456789abcdef"],
        ["git", "-C", "<root>", "worktree", "prune"],
        ["git", "-C", "<root>", "worktree", "add", "--detach", "--quiet", tree, "c0ffee0000000000000000000000000000000000"],
        ["docker", "rm", "--force", "runshape-install-.incoming-abc"],
        [
          "docker", "run", "--name", "runshape-install-.incoming-abc", ...hardening, "--network", "bridge",
          "-e", "npm_config_userconfig=/tmp/no-user-npmrc", "-e", "npm_config_globalconfig=/tmp/no-global-npmrc", "-e", "npm_config_ignore_scripts=true", "-e", "npm_config_git=/usr/bin/git",
          "-v", `${tree}:/target`, "--workdir", "/target", "runshape-recorder:0123456789abcdef", "npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund",
        ],
        ["docker", "rm", "--force", "runshape-record-.incoming-abc"],
        [
          "docker", "run", "--name", "runshape-record-.incoming-abc", ...hardening, "--network", "none",
          "-v", `${tree}:/target:ro`, "-v", "<root>/.runshape/recordings/.incoming-abc:/out",
          "--tmpfs", "/runshape/node_modules/.vite-temp:rw,uid=501,gid=20,size=64m",
          "-e", "RUNSHAPE_TARGET=/target", "-e", "RUNSHAPE_OUT=/out", "-e", "RUNSHAPE_RUN=run",
          "-e", "RUNSHAPE_CACHE=/tmp/runshape-cache",
          "--workdir", "/runshape", "runshape-recorder:0123456789abcdef", "sh", "-c",
          "node_modules/.bin/vitest run --config recorder-ts/vitest.record.config.ts --reporter=default --reporter=json --outputFile.json=/out/run.vitest.json > /out/run.log 2>&1; node recorder-ts/vitest-problems.mjs /out/run/manifest.json /out/run.vitest.json && echo '{\"run\":\"run\"}' > /out/latest.json",
        ],
        ["git", "-C", "<root>", "worktree", "prune"],
      ],
    });
    expect(existsSync(worktree)).toBe(false);
  });

  test("a link the commit's tests leave in the output folder refuses the recording before the host writes through it (second-model review)", async () => {
    // Reproduced: a link at /out/runshape.json made the host's next write overwrite a script
    // it later runs. Nothing on the host reads or writes a recording the sandbox left a link in.
    const { root, out, recorder } = setup({ leaves: (folder) => symlinkSync("../../../victim.sh", join(folder, "runshape.json")) });
    writeFileSync(join(root, "victim.sh"), "echo safe\n");

    const failure = await recorder.record({ kind: "commit", commit: "c0ffee" }, out).catch((error: Error) => error.message);

    expect({ failure, victim: readFileSync(join(root, "victim.sh"), "utf8") }).toEqual({
      failure: "the recording left runshape.json, which isn't a plain file (a link?): not used",
      victim: "echo safe\n",
    });
  });

  test("a lockfile that installs from outside the registry (a git dependency, a tarball URL) isn't installed at all", async () => {
    const lock = JSON.stringify({ packages: { "": {}, "node_modules/evil": { resolved: "git+ssh://git@example.com/evil.git#abc" } } });
    const { out, commands, recorder } = setup({ lock });

    const failure = await recorder.record({ kind: "commit", commit: "c0ffee" }, out).catch((error: Error) => error.message);

    expect({ failure, installed: commands.calls.some((call) => call.includes("ci")) }).toEqual({
      failure: "its lockfile installs from outside the npm registry, which can run code at install: node_modules/evil (git+ssh://git@example.com/evil.git#abc)",
      installed: false,
    });
  });

  test("a recording that runs out of time is killed, its worktree removed even if its .git was broken, and the timeout is what's reported", async () => {
    const { root, out, worktree, commands, recorder } = setup({
      answer: (command, args) => {
        if (command === "docker" && args[0] === "run" && args.includes("none")) {
          writeFileSync(join(worktree, ".git"), "gitdir: /nowhere"); // what the tests left of it
          return { code: null, signal: "SIGTERM", output: "" };
        }
        return undefined;
      },
    });

    await expect(recorder.record({ kind: "commit", commit: "c0ffee" }, out)).rejects.toThrowError("the recording ran out of time (20 minutes) and was stopped");
    expect({ killed: commands.calls.some((call) => call.join(" ").replace(root, "") === "docker kill runshape-record-.incoming-abc"), worktreeGone: !existsSync(worktree) }).toEqual({ killed: true, worktreeGone: true });
  });

  test("the working tree isn't sandboxed, and its environment names the image", async () => {
    const { out, recorder } = setup();

    await expect(recorder.record({ kind: "working" }, out)).rejects.toThrowError("--sandbox records commits; the working tree is yours, recorded on this machine without it");
    expect(recorder.environment).toBe("docker:runshape-recorder:0123456789abcdef");
  });
});
