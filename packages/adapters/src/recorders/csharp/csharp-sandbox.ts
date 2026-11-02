// The C# recorder in the sandbox (recorder-cs/sandbox/Dockerfile). The install fetches exactly
// the packages the commit's packages.lock.json files pin, from nuget.org only, through a project
// of the recorder's own (download-packages.sh): none of the commit's MSBuild runs while there's
// a network. The record step restores from those packages in locked mode, with no network, and
// runshape-cs records the tests. What runs when is in docs/design.md's threat model.
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

import { TestConfig } from "@runshape/kernel";

import { ContainerStep, readPlainFile, refuseCommitted, SandboxRecipe, SandboxRefusal } from "../docker-recorder";

/** Where the install puts the packages, inside the commit's folder: the record step reads them there. */
const PACKAGES_NAME = ".runshape-nuget";
const PACKAGES = `/target/${PACKAGES_NAME}`;
const LOCK_FILE = "packages.lock.json";
/** nuget.org's API: the service index and every package download are served from it. */
const NUGET_HOSTS = ["api.nuget.org:443"];
/** Folders a project's files are never in: build output, and anything hidden (.git). */
const SKIPPED = new Set(["bin", "obj", "node_modules"]);
/** NuGet's package ids and versions, and nothing that could be read as another argument or as XML. */
const PACKAGE_ID = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const VERSION = /^[0-9]+(\.[0-9]+){1,3}(-[A-Za-z0-9.-]+)?$/;
/** The .NET tools stay quiet, and keep what they write in /tmp (the root filesystem is read-only). */
const DOTNET = ["DOTNET_CLI_TELEMETRY_OPTOUT=1", "DOTNET_NOLOGO=1", "DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1", "DOTNET_CLI_HOME=/tmp", "MSBUILDDISABLENODEREUSE=1"];

export function csharpSandbox(config: TestConfig): SandboxRecipe {
  const env = (settings: string[]) => settings.flatMap((setting) => ["-e", setting]);
  let packages: string[] = [];
  return {
    language: "csharp",
    image: "runshape-recorder-cs",
    dockerfile: "recorder-cs/sandbox/Dockerfile",
    imageSources: ["recorder-cs/src", "recorder-cs/sandbox", "recorder-cs/nuget.config", "recorder-cs/global.json", "recorder-cs/Directory.Build.props", "recorder-ts/sandbox/registry-proxy.mjs", ".dockerignore"],
    registries: NUGET_HOSTS,
    async prepare(worktree: string): Promise<void> {
      // A committed package folder would be trusted as fetched: packages nuget.org never served.
      await refuseCommitted(worktree, [PACKAGES_NAME]);
      packages = await pinnedPackages(worktree);
    },
    install(proxy: string): ContainerStep {
      return {
        options: env([...DOTNET, `HTTPS_PROXY=${proxy}`, `HTTP_PROXY=${proxy}`]),
        workdir: "/tmp",
        // Each package an argument of its own, checked against PACKAGE_ID and VERSION: never a shell line.
        command: ["/runshape/recorder-cs/sandbox/download-packages.sh", ...packages],
      };
    },
    record(): ContainerStep {
      // dotnet test's targets as positional parameters: nothing from runshape.json is spliced into the line.
      const script = `dotnet /runshape/bin/runshape-cs.dll record -out /out -run run -locked /target "$@" > /out/run.log 2>&1 || true`;
      return {
        options: env([...DOTNET, `NUGET_PACKAGES=${PACKAGES}`]),
        workdir: "/runshape",
        command: ["sh", "-c", script, "sh", ...config.tests],
      };
    },
  };
}

/**
 * Every package the commit's projects pin, as "id@version": each .csproj needs its
 * packages.lock.json beside it (RestorePackagesWithLockFile), or nothing is installed.
 */
export async function pinnedPackages(worktree: string): Promise<string[]> {
  const projects = await projectFolders(worktree, "");
  if (projects.length === 0) throw new SandboxRefusal("the commit has no .csproj: there's no project to record");
  const packages = new Set<string>();
  const unlocked: string[] = [];
  for (const folder of projects) {
    const lockFile = folder === "" ? LOCK_FILE : `${folder}/${LOCK_FILE}`;
    if (!(await lstat(join(worktree, lockFile)).then(() => true, () => false))) {
      unlocked.push(folder === "" ? "." : folder);
      continue;
    }
    const text = await readPlainFile(worktree, lockFile, `the commit has no ${lockFile}`);
    let lock: { dependencies?: Record<string, Record<string, { type?: string; resolved?: string }>> };
    try {
      lock = JSON.parse(text.replace(/^﻿/, "")) as typeof lock;
    } catch {
      throw new SandboxRefusal(`its ${lockFile} isn't valid JSON: its packages can't be checked before fetching`);
    }
    let refused = 0;
    for (const framework of Object.values(lock.dependencies ?? {})) {
      for (const [id, entry] of Object.entries(framework ?? {})) {
        // Another project of the solution: built from the commit, not fetched.
        if (entry?.type === "Project") continue;
        if (PACKAGE_ID.test(id) && typeof entry?.resolved === "string" && VERSION.test(entry.resolved)) packages.add(`${id}@${entry.resolved}`);
        else refused += 1;
      }
    }
    if (refused > 0) throw new SandboxRefusal(`its ${lockFile} has ${refused} entries that aren't a package id and a pinned version: nothing is fetched`);
  }
  if (unlocked.length > 0) {
    throw new SandboxRefusal(`its projects in ${unlocked.join(", ")} have no ${LOCK_FILE}: their packages can't be fetched as pinned (set RestorePackagesWithLockFile and commit the lock files)`);
  }
  return [...packages].sort();
}

/** The folders holding a .csproj, "/"-separated from the commit's root; links aren't followed. */
async function projectFolders(worktree: string, relative: string): Promise<string[]> {
  const found: string[] = [];
  const entries = await readdir(join(worktree, relative), { withFileTypes: true });
  if (entries.some((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".csproj"))) found.push(relative);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || SKIPPED.has(entry.name)) continue;
    found.push(...(await projectFolders(worktree, relative === "" ? entry.name : `${relative}/${entry.name}`)));
  }
  return found;
}
