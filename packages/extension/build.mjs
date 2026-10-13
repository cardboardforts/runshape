// Bundles the extension host code (and @runshape/core) into one CommonJS file for VS Code.
// The webview is built separately by Vite into dist/webview.
import { build } from "esbuild";

await build({
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: true,
  external: ["vscode"],
  logLevel: "info",
});
