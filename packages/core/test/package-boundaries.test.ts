/**
 * The package layering, checked from the imports themselves: npm links every workspace into
 * node_modules, so nothing else stops @runshape/trace from importing @runshape/views.
 *
 *   trace  <-  architecture  <-  views  <-  core  <-  webview, extension, cli
 *
 * Each package may import only the packages before it, and lists each one it imports in its
 * package.json. The domain packages import nothing from Node, VS Code or React; the adapters
 * reach the domain only through @runshape/core. The TypeScript recorder stands alone: it writes
 * the trace format, it doesn't share code with the viewer.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");

/** Which @runshape packages each one may import. */
const ALLOWED: Record<string, string[]> = {
  "packages/trace": [],
  "packages/architecture": ["trace"],
  "packages/views": ["trace", "architecture"],
  "packages/core": ["trace", "architecture", "views"],
  "packages/webview": ["core"],
  "packages/extension": ["core"],
  "packages/cli": ["core"],
  "recorder-ts": [],
};
/** Packages whose source must run anywhere: in the webview, the extension host, or a CLI. */
const DOMAIN = new Set(["packages/trace", "packages/architecture", "packages/views", "packages/core"]);
const PLATFORM = /^(node:|vscode$|react($|-dom|\/))/;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

function importsOf(file: string): string[] {
  const text = readFileSync(file, "utf8");
  return [...text.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)"/g), ...text.matchAll(/\bimport\(\s*"([^"]+)"\s*\)/g)].map((match) => match[1]!);
}

describe("package boundaries", () => {
  test("every import points down the layering, and every package declares what it imports", () => {
    const violations: string[] = [];
    for (const [pkg, allowed] of Object.entries(ALLOWED)) {
      const declared = Object.keys(JSON.parse(readFileSync(join(ROOT, pkg, "package.json"), "utf8")).dependencies ?? {});
      const used = new Set<string>();
      for (const file of sourceFiles(join(ROOT, pkg, "src"))) {
        const where = relative(ROOT, file);
        for (const specifier of importsOf(file)) {
          const runshape = specifier.match(/^@runshape\/([^/]+)/)?.[1];
          if (runshape !== undefined) {
            used.add(`@runshape/${runshape}`);
            if (!allowed.includes(runshape)) violations.push(`${where} imports @runshape/${runshape}`);
          } else if (DOMAIN.has(pkg) && PLATFORM.test(specifier)) {
            violations.push(`${where} imports ${specifier}: domain packages run on any platform`);
          }
        }
      }
      for (const name of used) if (!declared.includes(name)) violations.push(`${pkg} imports ${name} without declaring it in package.json`);
    }

    expect(violations).toEqual([]);
  });
});
