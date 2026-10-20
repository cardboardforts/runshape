/**
 * The demo's vite.config.ts loads the recording library for its dev server, and the library
 * imports @runshape/infra. Vite's default config loader bundles the config but leaves packages
 * to Node, which can't resolve their extensionless TypeScript imports: `npm run dev` and
 * `npm run build` both failed to start that way (found in Phase 0, PR 4). The scripts load the
 * config with Vite's module runner instead; this loads it exactly as each script says to.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfigFromFile } from "vite";
import { describe, expect, test } from "vitest";

const WEBVIEW = join(import.meta.dirname, "..");
const scripts = JSON.parse(readFileSync(join(WEBVIEW, "package.json"), "utf8")).scripts as Record<string, string>;

describe("vite.config.ts", () => {
  test.each(["dev", "build"])("loads the way `npm run %s` loads it, with the recordings plugin", async (script) => {
    const loader = scripts[script]!.match(/--configLoader (\w+)/)?.[1] as "bundle" | "runner" | "native" | undefined;
    const command = script === "dev" ? "serve" : "build";

    const loaded = await loadConfigFromFile({ command, mode: "development" }, join(WEBVIEW, "vite.config.ts"), WEBVIEW, "silent", undefined, loader);

    expect({ loader, plugins: loaded?.config.plugins?.flat().map((plugin) => (plugin && "name" in plugin ? plugin.name : null)) }).toEqual({
      loader: "runner",
      plugins: expect.arrayContaining(["runshape-recordings"]),
    });
  });
});
