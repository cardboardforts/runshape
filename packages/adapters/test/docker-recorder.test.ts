/**
 * Recording a commit in a container: someone else's (or an agent's) tests, run unattended,
 * get the commit (read-only) and an output folder, and nothing else of this machine
 * (docs/design.md, threat model). What's handed to docker is checked flag by flag with the
 * commands faked; the checks the host makes itself (the commit's npm settings, its lockfile,
 * what the recording left behind) run on real files. A real recording runs it for real
 * (npm run runshape -- record <ref> --sandbox).
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { removeAnyway } from "@runshape/infra";
import { TestConfig } from "@runshape/kernel";
import { CommandResult, CommandRunner, DockerRecorder, SandboxRecipe } from "../src/recorders/docker-recorder";
import { goSandbox } from "../src/recorders/go/go-sandbox";
import { pythonSandbox } from "../src/recorders/python/python-sandbox";
import { typescriptSandbox } from "../src/recorders/typescript/typescript-sandbox";

/** Runshape recording itself: nothing set, so its own packages. */
const RUNSHAPE: TestConfig = { language: "typescript", chosenBy: "package.json", source: [], tests: [], args: [], interpreter: null };

// npm's own shape: a registry package, and a workspace (its link, and its folder, which has no resolved).
const REGISTRY_LOCK = JSON.stringify({
  lockfileVersion: 3,
  packages: {
    "": {},
    "node_modules/vitest": { resolved: "https://registry.npmjs.org/vitest/-/vitest-5.0.4.tgz" },
    "node_modules/@runshape/core": { resolved: "packages/core", link: true },
    "packages/core": { version: "0.1.0" },
  },
});

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
  /** A shrinkwrap beside the lockfile. */
  shrinkwrap?: string;
  /** What the recording container leaves in /out. */
  leaves?: (out: string) => void;
  answer?: (command: string, args: string[]) => CommandResult | undefined;
}

function setup({ lock = REGISTRY_LOCK, shrinkwrap, leaves, answer }: Options = {}) {
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
      if (shrinkwrap !== undefined) writeFileSync(join(worktree, "npm-shrinkwrap.json"), shrinkwrap);
    }
    if (command === "docker" && args[0] === "run" && args.includes("none")) {
      mkdirSync(join(out, "run"), { recursive: true });
      writeFileSync(join(out, "run", "manifest.json"), "{}");
      writeFileSync(join(out, "latest.json"), '{"run":"run"}');
      leaves?.(out);
    }
    return answer?.(command, args);
  });
  return { root, out, worktree, commands, recorder: new DockerRecorder(root, root, typescriptSandbox(RUNSHAPE), "0123456789abcdef", commands, "501:20") };
}

const relative = (root: string) => (call: string[]) => call.map((arg) => arg.split(root).join("<root>"));

describe("DockerRecorder", () => {
  test("builds the image from HEAD as committed, installs without the commit's npm settings or scripts, records with no network and the commit read-only", async () => {
    let npmrcAtInstall: boolean | null = null;
    const { root, out, worktree, commands, recorder } = setup({
      answer: (command, args) => {
        if (args[0] === "image") return { code: 1, signal: null, output: "No such image" };
        if (command === "docker" && args.includes("ci")) npmrcAtInstall = existsSync(join(worktree, ".npmrc"));
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
        ["sh", "-c", 'git -C "$1" archive --format=tar HEAD | docker build --tag "$2" --file "$3" -', "sh", "<root>", "runshape-recorder:0123456789abcdef", "recorder-ts/sandbox/Dockerfile"],
        // Leftovers of a run killed outright: none here (the fake docker lists nothing).
        ["docker", "ps", "--all", "--format", "{{.Names}}"],
        ["docker", "network", "ls", "--format", "{{.Name}}"],
        ["git", "-C", "<root>", "worktree", "prune"],
        ["git", "-C", "<root>", "worktree", "add", "--detach", "--quiet", tree, "c0ffee0000000000000000000000000000000000"],
        // The install's network: internal (no route out), its only other member the registry proxy.
        ["docker", "network", "create", "--internal", "-o", "com.docker.network.bridge.inhibit_ipv4=true", "runshape-install-.incoming-abc"],
        ["docker", "run", "--detach", "--name", "runshape-proxy-.incoming-abc", ...hardening, "--network", "bridge", "--workdir", "/runshape", "runshape-recorder:0123456789abcdef", "node", "recorder-ts/sandbox/registry-proxy.mjs"],
        ["docker", "network", "connect", "runshape-install-.incoming-abc", "runshape-proxy-.incoming-abc"],
        ["docker", "rm", "--force", "runshape-install-.incoming-abc"],
        [
          "docker", "run", "--name", "runshape-install-.incoming-abc", ...hardening, "--network", "runshape-install-.incoming-abc",
          "-e", "npm_config_userconfig=/tmp/no-user-npmrc", "-e", "npm_config_globalconfig=/tmp/no-global-npmrc", "-e", "npm_config_ignore_scripts=true", "-e", "npm_config_git=/usr/bin/git",
          "-e", "npm_config_proxy=http://runshape-proxy-.incoming-abc:3128", "-e", "npm_config_https_proxy=http://runshape-proxy-.incoming-abc:3128",
          "-e", "HTTPS_PROXY=http://runshape-proxy-.incoming-abc:3128", "-e", "HTTP_PROXY=http://runshape-proxy-.incoming-abc:3128",
          "-v", `${tree}:/target`, "--workdir", "/target", "runshape-recorder:0123456789abcdef", "npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund",
        ],
        ["docker", "rm", "--force", "runshape-install-.incoming-abc"],
        ["docker", "rm", "--force", "runshape-proxy-.incoming-abc"],
        ["docker", "network", "rm", "runshape-install-.incoming-abc"],
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
    const lock = JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/evil": { resolved: "git+ssh://git@example.com/evil.git#abc" } } });
    const { out, commands, recorder } = setup({ lock });

    const failure = await recorder.record({ kind: "commit", commit: "c0ffee" }, out).catch((error: Error) => error.message);

    expect({ failure, installed: commands.calls.some((call) => call.includes("ci")) }).toEqual({
      failure: "its lockfile installs from outside the npm registry, which can run code at install: node_modules/evil (git+ssh://git@example.com/evil.git#abc)",
      installed: false,
    });
  });

  test("a lockfile npm would resolve past the check isn't installed: an old one with no `packages`, an entry with no `resolved` (second re-review)", async () => {
    const dependenciesOnly = JSON.stringify({ lockfileVersion: 3, dependencies: { dep: { version: "git+file:///target/x.git" } } });
    const unresolved = JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/dep": { version: "1.0.0" } } });

    const failures = await Promise.all(
      [dependenciesOnly, unresolved].map((lock) => {
        const { out, recorder } = setup({ lock });
        return recorder.record({ kind: "commit", commit: "c0ffee" }, out).catch((error: Error) => error.message);
      }),
    );

    expect(failures).toEqual([
      "its lockfile isn't one npm 7+ writes (lockfileVersion 2 or 3, with packages): its dependencies can't be checked before installing",
      "its lockfile installs from outside the npm registry, which can run code at install: node_modules/dep (no resolved URL)",
    ]);
  });

  test("a folder the tests made unreadable (chmod 000) is refused and still cleaned away, not left to break every later run", async () => {
    const { out, recorder } = setup({
      leaves: (folder) => {
        mkdirSync(join(folder, "locked", "inside"), { recursive: true });
        chmodSync(join(folder, "locked"), 0o000);
      },
    });

    const failure = await recorder.record({ kind: "commit", commit: "c0ffee" }, out).catch((error: Error) => error.message);
    await removeAnyway(out);

    expect({ failure: failure?.startsWith("the recording left something it can't read"), gone: !existsSync(out) }).toEqual({ failure: true, gone: true });
  });

  test("runshape's own lockfile (workspaces, a bundled package or two) is installable; a bundled entry claiming a git source, or a link out of the project, isn't (third review)", async () => {
    const own = readFileSync(join(import.meta.dirname, "..", "..", "..", "package-lock.json"), "utf8");
    const bundledGit = JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/evil": { resolved: "git+https://example.invalid/evil.git#abc", inBundle: true } } });
    const linkOut = JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/evil": { resolved: "../../elsewhere", link: true } } });

    const outcomes = await Promise.all(
      [own, bundledGit, linkOut].map((lock) => {
        const { out, recorder } = setup({ lock });
        return recorder.record({ kind: "commit", commit: "c0ffee" }, out).then(() => "installed", (error: Error) => error.message);
      }),
    );

    expect(outcomes).toEqual([
      "installed",
      "its lockfile installs from outside the npm registry, which can run code at install: node_modules/evil (git+https://example.invalid/evil.git#abc)",
      "its lockfile links node_modules/evil outside the project (../../elsewhere)",
    ]);
  });

  test("a shrinkwrap (which npm prefers to the lockfile) isn't installed, nor a link whose target claims a source of its own (fourth review)", async () => {
    // A workspace with a node_modules of its own, the package in it saying no source but a
    // version that's a URL: npm fetches name@version (confirmed against a local server).
    const linkToEvil = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": {},
        "node_modules/a": { link: true, resolved: "packages/a" },
        "node_modules/x": { link: true, resolved: "packages/a/node_modules/x" },
        "packages/a": { name: "a" },
        "packages/a/node_modules/x": { name: "x", version: "http://127.0.0.1:8765/evil.tgz" },
      },
    });
    const shrinkwrapped = setup({ shrinkwrap: REGISTRY_LOCK });
    const outcomes = [
      await (async () => {
        const { out, recorder } = setup({ lock: linkToEvil });
        return recorder.record({ kind: "commit", commit: "c0ffee" }, out).then(() => "installed", (error: Error) => error.message);
      })(),
      await shrinkwrapped.recorder
        .record({ kind: "commit", commit: "c0ffee" }, shrinkwrapped.out)
        .then(() => "installed", (error: Error) => error.message),
    ];

    expect(outcomes).toEqual([
      "its lockfile installs from outside the npm registry, which can run code at install: packages/a/node_modules/x (no resolved URL)",
      "it has an npm-shrinkwrap.json, which npm installs from instead of package-lock.json: not checked, so not installed",
    ]);
  });

  test("a workspace's folder is exempt; a node_modules inside one isn't, even saying a plain version", async () => {
    const nested = JSON.stringify({
      lockfileVersion: 3,
      packages: { "": {}, "node_modules/a": { link: true, resolved: "packages/a" }, "node_modules/x": { link: true, resolved: "packages/a/node_modules/x" }, "packages/a": { version: "0.1.0" }, "packages/a/node_modules/x": { version: "1.0.0" } },
    });
    const { out, recorder } = setup({ lock: nested });

    expect(await recorder.record({ kind: "commit", commit: "c0ffee" }, out).catch((error: Error) => error.message)).toBe(
      "its lockfile installs from outside the npm registry, which can run code at install: packages/a/node_modules/x (no resolved URL)",
    );
  });

  test("a package that says no source must say a plain version: npm would fetch name@<URL> (fifth review)", async () => {
    const bundledUrl = JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/p": { resolved: "https://registry.npmjs.org/p/-/p-1.0.0.tgz" }, "node_modules/p/node_modules/q": { inBundle: true, version: "git+https://example.invalid/q.git" } } });
    const { out, recorder } = setup({ lock: bundledUrl });

    expect(await recorder.record({ kind: "commit", commit: "c0ffee" }, out).catch((error: Error) => error.message)).toBe(
      "its lockfile installs from outside the npm registry, which can run code at install: node_modules/p/node_modules/q (no resolved URL)",
    );
  });

  test("a package that says no source must say a plain name too: npm builds the fetch from name@version (sixth review)", async () => {
    const urlName = JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/x": { name: "http://127.0.0.1:8765/x.tgz#", version: "1.0.0", inBundle: true } } });
    const { out, recorder } = setup({ lock: urlName });

    expect(await recorder.record({ kind: "commit", commit: "c0ffee" }, out).catch((error: Error) => error.message)).toBe(
      "its lockfile installs from outside the npm registry, which can run code at install: node_modules/x (no resolved URL)",
    );
  });

  test("what a run killed outright left (an install still running, its proxy, their network) is removed before recording", async () => {
    const leftovers = { containers: "runshape-install-.incoming-old\nrunshape-proxy-.incoming-old\nsomeone-elses\n", networks: "bridge\nrunshape-install-.incoming-old\n" };
    const { out, commands, recorder } = setup({
      answer: (command, args) =>
        args[0] === "ps" ? { code: 0, signal: null, output: leftovers.containers } : args[0] === "network" && args[1] === "ls" ? { code: 0, signal: null, output: leftovers.networks } : undefined,
    });

    await recorder.record({ kind: "commit", commit: "c0ffee" }, out);

    expect(commands.calls.filter((call) => call.join(" ").includes(".incoming-old")).map((call) => call.join(" "))).toEqual([
      "docker rm --force runshape-install-.incoming-old",
      "docker rm --force runshape-proxy-.incoming-old",
      "docker network rm runshape-install-.incoming-old",
    ]);
  });

  test("a host user that's root still records as an unprivileged one", () => {
    const root = mkdtempSync(join(tmpdir(), "runshape-docker-"));

    expect(new DockerRecorder(root, root, typescriptSandbox(RUNSHAPE), "v", new FakeCommands(() => undefined), "0:0").user).toBe("1000:1000");
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

describe("a sandbox per language: the same container, network and checks; the image, install and test run the recorder's own", () => {
  /** Every step gets these, pinned flag by flag in the TypeScript test above: left out here so each language's own options show. */
  const HARDENING = new Set(["--rm", "--user", "--cap-drop", "--security-opt", "--read-only", "--tmpfs", "--memory", "--pids-limit", "--ulimit"]);
  const PYTHON: TestConfig = { language: "python", chosenBy: "pytest.ini", source: ["conduit"], tests: ["tests"], args: ["-k", "journey"], interpreter: null };
  const GO: TestConfig = { language: "go", chosenBy: "go.mod", source: [], tests: ["./..."], args: [], interpreter: null };

  /** The commit checked out with these files; the record step leaves a recording. */
  function sandboxFor(recipe: SandboxRecipe, files: Record<string, string>) {
    const root = mkdtempSync(join(tmpdir(), "runshape-docker-"));
    const out = join(root, ".runshape", "recordings", ".incoming-abc");
    const worktree = join(root, ".runshape", "worktrees", "sandbox-.incoming-abc");
    mkdirSync(out, { recursive: true });
    const commands = new FakeCommands((command, args) => {
      if (command === "git" && args.includes("add")) {
        mkdirSync(worktree, { recursive: true });
        for (const [path, text] of Object.entries(files)) writeFileSync(join(worktree, path), text);
      }
      if (command === "docker" && args[0] === "run" && args.includes("none")) {
        mkdirSync(join(out, "run"), { recursive: true });
        writeFileSync(join(out, "run", "manifest.json"), "{}");
        writeFileSync(join(out, "latest.json"), '{"run":"run"}');
      }
      return undefined;
    });
    const recorder = new DockerRecorder(root, root, recipe, "0123456789abcdef", commands, "501:20");
    const withoutHardening = (call: string[]) => {
      const kept: string[] = [];
      for (let i = call.indexOf("--name") + 1; i < call.length; i += 1) {
        if (HARDENING.has(call[i]!)) i += call[i] === "--rm" || call[i] === "--read-only" ? 0 : 1;
        else kept.push(call[i]!);
      }
      return kept.join(" ").split(root).join("<root>");
    };
    const steps = () => commands.calls.filter((call) => call[0] === "docker" && call[1] === "run").map(withoutHardening);
    return { steps, record: () => recorder.record({ kind: "commit", commit: "c0ffee" }, out).then(() => "recorded", (error: Error) => error.message) };
  }

  test("Python: wheels only, from PyPI only, into the commit's own venv; pytest with the recorder on PYTHONPATH and runshape.json's settings as arguments, never spliced into the shell line", async () => {
    const { steps, record } = sandboxFor(pythonSandbox(PYTHON), { "requirements.txt": '# pinned\nDjango==5.2.7\npytest==8.4.2 ; python_version >= "3.9"\n' });

    expect({ outcome: await record(), steps: steps() }).toEqual({
      outcome: "recorded",
      steps: [
        "runshape-proxy-.incoming-abc -e HOME=/tmp --network bridge -e RUNSHAPE_PROXY_ALLOW=pypi.org:443,files.pythonhosted.org:443 --workdir /runshape runshape-recorder-python:0123456789abcdef node recorder-ts/sandbox/registry-proxy.mjs",
        "runshape-install-.incoming-abc -e HOME=/tmp --network runshape-install-.incoming-abc -e PIP_CONFIG_FILE=/dev/null -e HTTPS_PROXY=http://runshape-proxy-.incoming-abc:3128 -e HTTP_PROXY=http://runshape-proxy-.incoming-abc:3128 -e https_proxy=http://runshape-proxy-.incoming-abc:3128 -v <root>/.runshape/worktrees/sandbox-.incoming-abc:/target --workdir /target runshape-recorder-python:0123456789abcdef sh -c python -m venv --system-site-packages /target/.runshape-venv && /target/.runshape-venv/bin/pip install --no-input --disable-pip-version-check --no-cache-dir --only-binary=:all: --index-url https://pypi.org/simple/ -r requirements.txt",
        'runshape-record-.incoming-abc -e HOME=/tmp --network none -v <root>/.runshape/worktrees/sandbox-.incoming-abc:/target:ro -v <root>/.runshape/recordings/.incoming-abc:/out -e PYTHONPATH=/runshape/recorder/src -e PYTHONDONTWRITEBYTECODE=1 --workdir /target runshape-recorder-python:0123456789abcdef sh -c /target/.runshape-venv/bin/python -m runshape_recorder.run --runshape-out=/out --runshape-run-name=run -p no:cacheprovider "$@" > /out/run.log 2>&1 || true sh -o runshape_source=conduit tests -k journey',
      ],
    });
  });

  test("Python: a requirements.txt naming another index, a URL, an editable, another file or an unpinned version isn't installed at all; nor is a commit without one", async () => {
    const lines = ["Django==5.2.7", "--extra-index-url https://evil.example/simple", "evil @ https://evil.example/evil.whl", "-e .", "-r more.txt", "requests>=2"].join("\n");
    const refused = sandboxFor(pythonSandbox(PYTHON), { "requirements.txt": lines });
    const missing = sandboxFor(pythonSandbox(PYTHON), {});

    expect({ refused: await refused.record(), installed: refused.steps().some((step) => step.startsWith("runshape-install-")), missing: await missing.record() }).toEqual({
      refused: "its requirements.txt has lines that aren't a pinned release (name==version), which could install from elsewhere or build from source: --extra-index-url https://evil.example/simple, evil @ https://evil.example/evil.whl, -e .",
      installed: false,
      missing: "the commit has no requirements.txt: its dependencies can't be installed as pinned (a lockfile of poetry's or uv's isn't read yet)",
    });
  });

  test("Go: modules from the Go proxy only, checked against the checksum database, one toolchain; runshape-go records from the module cache with no network", async () => {
    const { steps, record } = sandboxFor(goSandbox(GO), { "go.mod": "module example.com/shop\n\ngo 1.22\n" });
    const pinned = "-e GOTOOLCHAIN=local -e GOWORK=off -e GOENV=off -e GOCACHE=/tmp/go-cache -e GOPATH=/tmp/go -e GOMODCACHE=/target/.runshape-gomod -e GOPRIVATE= -e GONOPROXY= -e GONOSUMDB= -e GOINSECURE= -e GOVCS=*:off";

    expect({ outcome: await record(), steps: steps() }).toEqual({
      outcome: "recorded",
      steps: [
        "runshape-proxy-.incoming-abc -e HOME=/tmp --network bridge -e RUNSHAPE_PROXY_ALLOW=proxy.golang.org:443,sum.golang.org:443 --workdir /runshape runshape-recorder-go:0123456789abcdef node recorder-ts/sandbox/registry-proxy.mjs",
        `runshape-install-.incoming-abc -e HOME=/tmp --network runshape-install-.incoming-abc ${pinned} -e GOPROXY=https://proxy.golang.org -e GOSUMDB=sum.golang.org -e GOFLAGS=-mod=readonly -e HTTPS_PROXY=http://runshape-proxy-.incoming-abc:3128 -e HTTP_PROXY=http://runshape-proxy-.incoming-abc:3128 -v <root>/.runshape/worktrees/sandbox-.incoming-abc:/target --workdir /target runshape-recorder-go:0123456789abcdef go mod download`,
        `runshape-record-.incoming-abc -e HOME=/tmp --network none -v <root>/.runshape/worktrees/sandbox-.incoming-abc:/target:ro -v <root>/.runshape/recordings/.incoming-abc:/out ${pinned} -e GOPROXY=off -e GOSUMDB=off -e GOFLAGS=-mod=mod --workdir /runshape runshape-recorder-go:0123456789abcdef sh -c /runshape/bin/runshape-go record -out /out -run run /target "$@" > /out/run.log 2>&1 || true sh ./...`,
      ],
    });
  });

  test("Go: a commit with no go.mod at its root has no module to record", async () => {
    expect(await sandboxFor(goSandbox(GO), {}).record()).toBe("the commit has no go.mod at its root: there's no module to record");
  });
});
