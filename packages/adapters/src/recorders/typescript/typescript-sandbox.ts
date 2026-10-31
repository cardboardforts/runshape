// The TypeScript recorder in the sandbox (recorder-ts/sandbox/Dockerfile): npm installs the
// commit's lockfile with no scripts, from the npm registry only, and vitest records it.
import { lstat, readFile, rm } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";

import { TestConfig } from "@runshape/kernel";

import { ContainerStep, SandboxRecipe, SandboxRefusal } from "../docker-recorder";
import { vitestEnvironment } from "./typescript-recorder";

/** The only place lockfile entries may come from: anything else (git, a tarball URL, a path) can run code at install. */
const NPM_REGISTRY = "https://registry.npmjs.org/";
/** A package's name as npm allows it: anything else in `name` (a URL) is somewhere npm would fetch from. */
const PACKAGE_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
/** A version and nothing else (semver): anything more (a URL, a git spec) is somewhere npm would fetch from. */
const PLAIN_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
/** npm 7+ lockfiles list every package with where it comes from; older ones don't. */
const MIN_LOCKFILE_VERSION = 2;

export function typescriptSandbox(config: TestConfig): SandboxRecipe {
  return {
    language: "typescript",
    image: "runshape-recorder",
    dockerfile: "recorder-ts/sandbox/Dockerfile",
    imageSources: ["recorder-ts", "package-lock.json", ".dockerignore"],
    // The proxy's own default: registry.npmjs.org.
    registries: null,
    async prepare(worktree: string): Promise<void> {
      // The commit's own npm settings could name a program to run as git, or a registry: gone.
      await rm(join(worktree, ".npmrc"), { force: true });
      await refuseUnregisteredPackages(worktree);
    },
    install(proxy: string): ContainerStep {
      return {
        options: [
          "-e", "npm_config_userconfig=/tmp/no-user-npmrc", "-e", "npm_config_globalconfig=/tmp/no-global-npmrc",
          "-e", "npm_config_ignore_scripts=true", "-e", "npm_config_git=/usr/bin/git",
          "-e", `npm_config_proxy=${proxy}`, "-e", `npm_config_https_proxy=${proxy}`, "-e", `HTTPS_PROXY=${proxy}`, "-e", `HTTP_PROXY=${proxy}`,
        ],
        workdir: "/target",
        command: ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"],
      };
    },
    record(): ContainerStep {
      const script = [
        "node_modules/.bin/vitest run --config recorder-ts/vitest.record.config.ts --reporter=default --reporter=json --outputFile.json=/out/run.vitest.json > /out/run.log 2>&1",
        "node recorder-ts/vitest-problems.mjs /out/run/manifest.json /out/run.vitest.json && echo '{\"run\":\"run\"}' > /out/latest.json",
      ].join("; ");
      const settings = Object.entries(vitestEnvironment(config)).flatMap(([name, value]) => ["-e", `${name}=${value}`]);
      return {
        options: [
          // Vite bundles its config next to its install: the one place in the read-only image it writes.
          "--tmpfs", "/runshape/node_modules/.vite-temp:rw,uid={uid},gid={gid},size=64m",
          "-e", "RUNSHAPE_TARGET=/target", "-e", "RUNSHAPE_OUT=/out", "-e", "RUNSHAPE_RUN=run",
          // Vite's and vitest's caches would go in the commit's node_modules, which is read-only.
          "-e", "RUNSHAPE_CACHE=/tmp/runshape-cache",
          ...settings,
        ],
        workdir: "/runshape",
        command: ["sh", "-c", script],
      };
    },
  };
}

/** A lockfile entry from anywhere but the registry (git, a URL, a path) can run code as npm installs it. */
async function refuseUnregisteredPackages(worktree: string): Promise<void> {
  if (await lstat(join(worktree, "npm-shrinkwrap.json")).then(() => true, () => false)) {
    throw new SandboxRefusal("it has an npm-shrinkwrap.json, which npm installs from instead of package-lock.json: not checked, so not installed");
  }
  const text = await readFile(join(worktree, "package-lock.json"), "utf8").catch(() => null);
  if (text === null) throw new SandboxRefusal("the commit has no package-lock.json: its dependencies can't be installed as locked");
  const lock = JSON.parse(text) as { lockfileVersion?: number; packages?: Record<string, { resolved?: string; name?: string; version?: string; link?: boolean; inBundle?: boolean }> };
  // Without `packages` npm resolves dependencies itself, past anything checked here.
  if ((lock.lockfileVersion ?? 0) < MIN_LOCKFILE_VERSION || typeof lock.packages !== "object" || lock.packages === null) {
    throw new SandboxRefusal("its lockfile isn't one npm 7+ writes (lockfileVersion 2 or 3, with packages): its dependencies can't be checked before installing");
  }
  // A workspace: a link to a folder of the project, and that folder (which has no resolved of its own).
  const linked = new Set<string>();
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!entry.link) continue;
    if (entry.resolved === undefined || isAbsolute(entry.resolved) || normalize(entry.resolved).startsWith("..")) {
      throw new SandboxRefusal(`its lockfile links ${path} outside the project (${entry.resolved ?? "nowhere"})`);
    }
    linked.add(normalize(entry.resolved));
  }
  // Every other package says it comes from the registry; one that doesn't is resolved by npm,
  // from anywhere. A bundled one comes inside its parent's tarball, and says nothing of its own.
  const outside = Object.entries(lock.packages)
    .filter(([path, entry]) => {
      if (path === "" || entry.link) return false;
      // Without a source of its own npm fetches name@version: both must be plain, or they spell a
      // URL npm goes to. A workspace's folder: linked to, no node_modules anywhere in it.
      const plain =
        entry.resolved === undefined && (entry.version === undefined || PLAIN_VERSION.test(entry.version)) && (entry.name === undefined || PACKAGE_NAME.test(entry.name));
      if (plain && linked.has(path) && !path.split("/").includes("node_modules")) return false;
      if (plain && entry.inBundle) return false;
      return entry.resolved === undefined || !entry.resolved.startsWith(NPM_REGISTRY);
    })
    .map(([path, entry]) => `${path} (${entry.resolved ?? "no resolved URL"})`);
  if (outside.length > 0) throw new SandboxRefusal(`its lockfile installs from outside the npm registry, which can run code at install: ${outside.slice(0, 3).join(", ")}`);
}
