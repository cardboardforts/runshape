/**
 * The target architecture (GOALS.md, "Rules a tool checks"), checked from the imports
 * themselves: npm links every workspace into node_modules, so nothing else stops one package
 * importing another.
 *
 *   apps (cli, extension) ──> modules, workflows, infra, kernel
 *   workflows ──> modules, kernel          ui (webview) ──> kernel
 *   modules (architecture, trace, visualizer, explainer) ──> kernel, never each other
 *   adapters (one folder per external system) ──> kernel, and infra's Node toolkit
 *   infra (the generic Node toolkit) ──> nothing: it fits the kernel's ports by shape
 *   kernel ──> nothing
 *
 * What the code still does that the target forbids is listed in NOT_YET; Phase 0b (PLAN.md)
 * empties it one PR at a time, and an entry that's no longer true fails, so the list only
 * shrinks. Each package also lists what it imports in its package.json. The kernel and the
 * modules import nothing from Node, VS Code or React. The TypeScript recorder stands alone: it
 * writes the trace format, it doesn't share code with the viewer.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, test } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");

type Role = "kernel" | "module" | "workflows" | "toolkit" | "infra" | "ui" | "app" | "recorder";

/** What each package is, in the target architecture. */
const ROLES: Record<string, Role> = {
  "packages/kernel": "kernel",
  "packages/architecture": "module",
  "packages/trace": "module",
  "packages/explainer": "module",
  "packages/visualizer": "module",
  "packages/workflows": "workflows",
  "packages/infra": "toolkit",
  "packages/adapters": "infra",
  "packages/webview": "ui",
  "packages/extension": "app",
  "packages/cli": "app",
  "recorder-ts": "recorder",
};
const named = (role: Role) => Object.keys(ROLES).filter((pkg) => ROLES[pkg] === role).map((pkg) => pkg.split("/").pop()!);

/** Which @runshape packages a role may import. */
const PERMITTED: Record<Role, string[]> = {
  kernel: named("kernel"),
  module: named("kernel"),
  workflows: [...named("kernel"), ...named("module")],
  // The generic Node toolkit: no Runshape package at all; the kernel's ports it fits by shape.
  toolkit: [],
  // The adapters: the kernel's ports, built on the toolkit (NodeFiles, locks).
  infra: [...named("kernel"), "infra"],
  ui: named("kernel"),
  app: Object.keys(ROLES).map((pkg) => pkg.split("/").pop()!),
  recorder: [],
};

/** Imports the target forbids that the code still has. Phase 0b removes them. */
const NOT_YET: Record<string, string[]> = {
  "packages/kernel": ["architecture", "trace", "visualizer"], // the UI protocol's view models, type-only (Phase 3)
  "packages/webview": ["architecture", "trace", "visualizer"], // the UI draws the modules' view models (Phase 3)
};

/** Which @runshape packages each one may import: its role's, and what it doesn't yet do without. */
const ALLOWED: Record<string, string[]> = Object.fromEntries(
  Object.entries(ROLES).map(([pkg, role]) => [pkg, [...PERMITTED[role].filter((name) => `packages/${name}` !== pkg), ...(NOT_YET[pkg] ?? [])]]),
);
/** Test helpers other packages' tests may share: a real git repository, and recordings kept in it. */
const SHARED_TEST_HELPERS = new Set(["@runshape/adapters/test/repository"]);
/** The only packages that touch the disk themselves: infra, and the hosts that compose everything. */
const DISK = new Set(["packages/infra", "packages/adapters", "packages/cli", "packages/extension", "recorder-ts"]);
/** Packages whose source must run anywhere: in the webview, the extension host, or a CLI. */
const DOMAIN = new Set(Object.keys(ROLES).filter((pkg) => ["kernel", "module", "workflows"].includes(ROLES[pkg]!)));
const NODE_BUILTINS = new Set(builtinModules);
function isPlatform(specifier: string): boolean {
  return specifier.startsWith("node:") || NODE_BUILTINS.has(specifier.split("/")[0]!) || /^(vscode$|react($|-dom|\/))/.test(specifier);
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Every module a file names: `from "x"`, `import "x"`, `import("x")`, `require("x")`, in either quote. */
function importsOf(text: string): string[] {
  return [...text.matchAll(/(?:\bfrom|\bimport|\brequire)\s*\(?\s*(["'])([^"'\n]+)\1/g)].map((match) => match[2]!);
}

describe("package boundaries", () => {
  test("every import is one the target architecture allows (or NOT_YET lists), and every package declares what it imports", () => {
    const violations: string[] = [];
    const packages = [...readdirSync(join(ROOT, "packages")).map((name) => `packages/${name}`), "recorder-ts"];
    for (const pkg of packages) {
      if (existsSync(join(ROOT, pkg, "package.json")) && !(pkg in ALLOWED)) violations.push(`${pkg} has no role: add it to ROLES`);
    }
    for (const [pkg, allowed] of Object.entries(ALLOWED)) {
      const declared = Object.keys(JSON.parse(readFileSync(join(ROOT, pkg, "package.json"), "utf8")).dependencies ?? {});
      const used = new Set<string>();
      for (const file of sourceFiles(join(ROOT, pkg, "src"))) {
        const where = relative(ROOT, file);
        const text = readFileSync(file, "utf8");
        if (/\bimport\s*\(\s*`/.test(text)) violations.push(`${where} imports a computed path, which can't be checked`);
        for (const specifier of importsOf(text)) {
          if (specifier.startsWith(".") && !resolve(dirname(file), specifier).startsWith(join(ROOT, pkg, "src"))) {
            violations.push(`${where} reaches outside its package: ${specifier}`);
          }
          const runshape = specifier.match(/^@runshape\/([^/]+)/)?.[1];
          if (runshape !== undefined) {
            used.add(`@runshape/${runshape}`);
            // The kernel may name a module's types (NOT_YET), never load it: that would be a cycle.
            if (ROLES[pkg] === "kernel" && ROLES[`packages/${runshape}`] !== "kernel" && !new RegExp(`import type [^;]*["']${specifier}["']`).test(text)) {
              violations.push(`${where} loads @runshape/${runshape} at runtime: the kernel may only import its types`);
            }
            if (!allowed.includes(runshape)) violations.push(`${where} imports @runshape/${runshape}`);
            // A package by its name, never its insides: what it exports is what it offers.
            if (specifier !== `@runshape/${runshape}`) violations.push(`${where} reaches inside @runshape/${runshape}: ${specifier}`);
          } else if (DOMAIN.has(pkg) && isPlatform(specifier)) {
            violations.push(`${where} imports ${specifier}: domain packages run on any platform`);
          } else if (!DISK.has(pkg) && /^(node:)?fs(\/|$)/.test(specifier)) {
            violations.push(`${where} imports ${specifier}: only infra and the hosts touch the disk (use @runshape/infra)`);
          }
        }
      }
      for (const name of used) if (!declared.includes(name)) violations.push(`${pkg} imports ${name} without declaring it in package.json`);
      for (const name of NOT_YET[pkg] ?? []) {
        if (!used.has(`@runshape/${name}`)) violations.push(`${pkg} no longer imports @runshape/${name}: remove it from NOT_YET`);
      }
    }

    expect(violations).toEqual([]);
  });

  test("a package's tests reach only its own source, the packages below it, trace's fixtures and the shared test helpers", () => {
    // So each package's tests run on their own: a views test importing core would tie them.
    const violations: string[] = [];
    const fixtures = join(ROOT, "packages", "kernel", "test", "fixtures");
    const isFixtures = (target: string) => target === fixtures || target.startsWith(`${fixtures}/`) || target.startsWith(`${fixtures}.`);
    // The webview's demo runs against the same fixtures, so it's held to the same rule. Its
    // recordings page reads the library's overview through the dev server, whose routes
    // (dev-server/) read the library through infra; their tests make libraries to read, and
    // get what the viewer draws from the session, as the demo does.
    const HOST_ALSO: Record<string, Record<string, string[]>> = {
      "packages/webview": { demo: ["adapters", "workflows"], "dev-server": ["adapters", "infra"], test: ["adapters", "infra", "workflows"] },
    };
    // A module's tests may wire other modules the way a workflow does (the arch module draws
    // the graphs the trace module's diffs take): values between them, never imports in src.
    const WIRING = PERMITTED.workflows;
    const folders = Object.entries(ALLOWED).flatMap(([pkg, allowed]) =>
      ["test", "demo", "dev-server"].map((folder) => {
        const wiring = folder === "test" && ROLES[pkg] === "module" ? WIRING : [];
        return { pkg, allowed: [...allowed, ...wiring, ...(HOST_ALSO[pkg]?.[folder] ?? [])], folder: join(ROOT, pkg, folder) };
      }),
    );
    for (const { pkg, allowed, folder } of folders) {
      if (!existsSync(folder)) continue;
      for (const file of sourceFiles(folder).filter((path) => !isFixtures(path))) {
        const where = relative(ROOT, file);
        for (const specifier of importsOf(readFileSync(file, "utf8"))) {
          const runshape = specifier.match(/^@runshape\/([^/]+)/)?.[1];
          if (runshape !== undefined && !allowed.includes(runshape)) violations.push(`${where} imports @runshape/${runshape}`);
          // A package by name, never its insides: a name with a path is its test code or
          // internals, which only the named shared fixtures may be.
          if (runshape !== undefined && specifier !== `@runshape/${runshape}` && !SHARED_TEST_HELPERS.has(specifier)) {
            violations.push(`${where} reaches inside @runshape/${runshape}: ${specifier}`);
          }
          if (!specifier.startsWith(".")) continue;
          const target = resolve(dirname(file), specifier);
          if (!target.startsWith(join(ROOT, pkg) + "/") && !isFixtures(target)) violations.push(`${where} reaches outside its package: ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
