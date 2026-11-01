// The Go recorder in the sandbox (recorder-go/sandbox/Dockerfile): `go mod download` fetches the
// commit's modules from the Go module proxy, checked against the checksum database, and
// runshape-go records the tests.
import { lstat } from "node:fs/promises";
import { join } from "node:path";

import { TestConfig } from "@runshape/kernel";

import { ContainerStep, refuseCommitted, SandboxRecipe, SandboxRefusal } from "../docker-recorder";

/** Where the install puts the commit's modules, inside its folder: the record step reads them there. */
const MODULE_CACHE_NAME = ".runshape-gomod";
const MODULE_CACHE = `/target/${MODULE_CACHE_NAME}`;
const GO_PROXY_HOSTS = ["proxy.golang.org:443", "sum.golang.org:443"];
/**
 * Settings the commit can't change: one toolchain (a go.mod asking for another would download
 * and run it), no workspace file, no go env file, the build cache in /tmp. Nothing private:
 * every module is fetched from the proxy and checked against the checksum database.
 */
const PINNED_GO = [
  "GOTOOLCHAIN=local", "GOWORK=off", "GOENV=off", "GOCACHE=/tmp/go-cache", "GOPATH=/tmp/go", `GOMODCACHE=${MODULE_CACHE}`,
  "GOPRIVATE=", "GONOPROXY=", "GONOSUMDB=", "GOINSECURE=", "GOVCS=*:off",
];

export function goSandbox(config: TestConfig): SandboxRecipe {
  const env = (settings: string[]) => settings.flatMap((setting) => ["-e", setting]);
  return {
    language: "go",
    image: "runshape-recorder-go",
    dockerfile: "recorder-go/sandbox/Dockerfile",
    imageSources: ["recorder-go", "recorder-ts/sandbox/registry-proxy.mjs", ".dockerignore"],
    registries: GO_PROXY_HOSTS,
    async prepare(worktree: string): Promise<void> {
      // A committed module cache would be trusted as fetched: modules the checksum database never saw.
      await refuseCommitted(worktree, [MODULE_CACHE_NAME]);
      if (!(await lstat(join(worktree, "go.mod")).then((entry) => entry.isFile(), () => false))) {
        throw new SandboxRefusal("the commit has no go.mod at its root: there's no module to record");
      }
    },
    install(proxy: string): ContainerStep {
      return {
        options: env([...PINNED_GO, "GOPROXY=https://proxy.golang.org", "GOSUMDB=sum.golang.org", "GOFLAGS=-mod=readonly", `HTTPS_PROXY=${proxy}`, `HTTP_PROXY=${proxy}`]),
        workdir: "/target",
        command: ["go", "mod", "download"],
      };
    },
    record(): ContainerStep {
      // go test's packages as positional parameters: nothing from runshape.json is spliced into the line.
      const script = `/runshape/bin/runshape-go record -out /out -run run /target "$@" > /out/run.log 2>&1 || true`;
      return {
        // The instrumented copy's go.mod changes (it points at the recorder): -mod=mod, from the cache only.
        options: env([...PINNED_GO, "GOPROXY=off", "GOSUMDB=off", "GOFLAGS=-mod=mod"]),
        workdir: "/runshape",
        command: ["sh", "-c", script, "sh", ...config.tests],
      };
    },
  };
}
