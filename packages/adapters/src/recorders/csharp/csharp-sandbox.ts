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
/**
 * nuget.org's API: the service index, and every package download (its PackageBaseAddress is
 * api.nuget.org/v3-flatcontainer/, which serves the .nupkg itself, no redirect). Checked on a
 * real sandboxed recording of examples/cs-shop: with only this host allowed, every package came.
 */
export const NUGET_HOSTS = ["api.nuget.org:443"];
/** Folders a project's files are never in: build output, and anything hidden (.git). */
const SKIPPED = new Set(["bin", "obj", "node_modules"]);
/** NuGet's package ids and versions, and nothing that could be read as another argument or as XML. */
const PACKAGE_ID = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const VERSION = /^[0-9]+(\.[0-9]+){1,3}(-[A-Za-z0-9.-]+)?$/;
/** Far past a real project's lock file (cs-shop's are 8 and 12 KB) and package count: past them, nothing is read or fetched. */
const MAX_LOCK_FILE_BYTES = 1024 ** 2;
const MAX_PACKAGES = 2000;
/**
 * The .NET the image's SDK targets without fetching anything: a project for another needs its
 * targeting pack, which no lock file pins, so it can't restore offline (it records on the host).
 */
const SANDBOX_DOTNET_MAJOR = 10;
/** A target framework that needs a targeting pack: net5.0-net9.0 (and their -platform forms), netcoreapp*. */
const NEEDS_TARGETING_PACK = /^(net([5-9])\.\d+(-.*)?|netcoreapp\d+\.\d+)$/i;
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
  await refuseOlderFrameworks(worktree, projects);
  const packages = new Set<string>();
  const unlocked: string[] = [];
  for (const folder of projects) {
    const lockFile = folder === "" ? LOCK_FILE : `${folder}/${LOCK_FILE}`;
    if (!(await lstat(join(worktree, lockFile)).then(() => true, () => false))) {
      unlocked.push(folder === "" ? "." : folder);
      continue;
    }
    const text = await readPlainFile(worktree, lockFile, `the commit has no ${lockFile}`, MAX_LOCK_FILE_BYTES);
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
  if (packages.size > MAX_PACKAGES) throw new SandboxRefusal(`its lock files pin ${packages.size} packages, over ${MAX_PACKAGES}: nothing is fetched`);
  if (unlocked.length > 0) {
    throw new SandboxRefusal(`its projects in ${unlocked.join(", ")} have no ${LOCK_FILE}: their packages can't be fetched as pinned (set RestorePackagesWithLockFile and commit the lock files)`);
  }
  return [...packages].sort();
}

/**
 * Target frameworks the sandbox can't restore offline, as the project files and the
 * Directory.Build.props above them say (read as text, never evaluated): refused, naming them.
 */
async function refuseOlderFrameworks(worktree: string, projects: string[]): Promise<void> {
  const files = new Set<string>();
  for (const folder of projects) {
    for (const entry of await readdir(join(worktree, folder), { withFileTypes: true })) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".csproj")) files.add(folder === "" ? entry.name : `${folder}/${entry.name}`);
    }
    const parts = folder === "" ? [] : folder.split("/");
    for (let depth = 0; depth <= parts.length; depth += 1) files.add([...parts.slice(0, depth), "Directory.Build.props"].join("/"));
  }
  const older = new Set<string>();
  for (const file of [...files].sort()) {
    const entry = await lstat(join(worktree, file)).catch(() => null);
    if (entry === null) continue;
    const text = await readPlainFile(worktree, file, `the commit has no ${file}`, MAX_LOCK_FILE_BYTES);
    for (const match of text.matchAll(/<TargetFrameworks?>([^<]*)<\/TargetFrameworks?>/g)) {
      for (const framework of match[1]!.split(";").map((part) => part.trim())) if (NEEDS_TARGETING_PACK.test(framework)) older.add(framework.toLowerCase());
    }
  }
  if (older.size > 0) {
    throw new SandboxRefusal(`it targets ${[...older].sort().join(", ")}: the sandbox restores offline with .NET ${SANDBOX_DOTNET_MAJOR}'s SDK, which has no targeting pack for it (no lock file pins one), so record it on the host`);
  }
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
