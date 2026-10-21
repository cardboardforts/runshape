/**
 * The package layering, checked from the imports themselves: npm links every workspace into
 * node_modules, so nothing else stops @runshape/trace from importing @runshape/views.
 *
 *   trace  <-  architecture  <-  views  <-  core  <-  webview, extension, cli
 *                                                     library  <-  cli
 *                                           infra  <-  library, extension, cli
 *
 * Each package may import only the packages before it, and lists each one it imports in its
 * package.json. The domain packages import nothing from Node, VS Code or React; the adapters
 * reach the domain only through @runshape/core. Infra keeps files and imports no Runshape
 * package: trace declares the port it reads through, and infra's stores fit it by shape. The
 * library (recordings on disk, git refs) is a Node adapter of its own, for the CLI and the
 * demo's dev server. The TypeScript recorder stands alone: it writes the trace format, it
 * doesn't share code with the viewer.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, test } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");

/** Which @runshape packages each one may import. */
const ALLOWED: Record<string, string[]> = {
  "packages/trace": [],
  "packages/infra": [],
  "packages/architecture": ["trace"],
  "packages/views": ["trace", "architecture"],
  "packages/core": ["trace", "architecture", "views"],
  "packages/webview": ["core"],
  "packages/extension": ["core", "infra"],
  "packages/cli": ["core", "library", "infra"],
  "packages/library": ["infra"],
  "recorder-ts": [],
};
/** Test helpers other packages' tests may share: a real git repository, and recordings kept in it. */
const SHARED_TEST_HELPERS = new Set(["@runshape/library/test/repository"]);
/** The only packages that touch the disk themselves: infra, and the hosts that compose everything. */
const DISK = new Set(["packages/infra", "packages/cli", "packages/extension", "recorder-ts"]);
/** Packages whose source must run anywhere: in the webview, the extension host, or a CLI. */
const DOMAIN = new Set(["packages/trace", "packages/architecture", "packages/views", "packages/core"]);
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
  test("every import points down the layering, and every package declares what it imports", () => {
    const violations: string[] = [];
    const packages = [...readdirSync(join(ROOT, "packages")).map((name) => `packages/${name}`), "recorder-ts"];
    for (const pkg of packages) {
      if (existsSync(join(ROOT, pkg, "package.json")) && !(pkg in ALLOWED)) violations.push(`${pkg} is not in the layering: add it to ALLOWED`);
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
            if (!allowed.includes(runshape)) violations.push(`${where} imports @runshape/${runshape}`);
          } else if (DOMAIN.has(pkg) && isPlatform(specifier)) {
            violations.push(`${where} imports ${specifier}: domain packages run on any platform`);
          } else if (!DISK.has(pkg) && /^(node:)?fs(\/|$)/.test(specifier)) {
            violations.push(`${where} imports ${specifier}: only infra and the hosts touch the disk (use @runshape/infra)`);
          }
        }
      }
      for (const name of used) if (!declared.includes(name)) violations.push(`${pkg} imports ${name} without declaring it in package.json`);
    }

    expect(violations).toEqual([]);
  });

  test("a package's tests reach only its own source, the packages below it, trace's fixtures and the shared test helpers", () => {
    // So each package's tests run on their own: a views test importing core would tie them.
    const violations: string[] = [];
    const fixtures = join(ROOT, "packages", "trace", "test", "fixtures");
    const isFixtures = (target: string) => target === fixtures || target.startsWith(`${fixtures}/`) || target.startsWith(`${fixtures}.`);
    // The webview's demo runs against the same fixtures, so it's held to the same rule. Its
    // recordings page reads the library's overview through the dev server, whose routes
    // (dev-server/) read the library through infra; their tests make libraries to read.
    const HOST_ALSO: Record<string, Record<string, string[]>> = {
      "packages/webview": { demo: ["library"], "dev-server": ["library", "infra"], test: ["library", "infra"] },
    };
    const folders = Object.entries(ALLOWED).flatMap(([pkg, allowed]) =>
      ["test", "demo", "dev-server"].map((folder) => ({ pkg, allowed: [...allowed, ...(HOST_ALSO[pkg]?.[folder] ?? [])], folder: join(ROOT, pkg, folder) })),
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
