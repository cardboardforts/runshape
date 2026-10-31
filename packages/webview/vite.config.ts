import { execFileSync } from "node:child_process";
import { join } from "node:path";

// Loaded with vite's module runner (--configLoader runner in package.json): its default loader
// leaves packages to Node, which can't load their TypeScript (test/vite-config.test.ts).
import { GitCli, GitRepository, projectLibrary } from "@runshape/adapters";

import { handleLibraryRequest } from "./dev-server/library-routes";
import react from "@vitejs/plugin-react";
import { defineConfig, Plugin } from "vite";

/**
 * The demo's recordings page reads .runshape/recordings through the dev server, live: a
 * recording made while it runs shows up on the next load, no restart. Dev server only; the
 * extension's build never has it.
 */
function recordingLibrary(): Plugin {
  return {
    name: "runshape-recordings",
    apply: "serve",
    configureServer(server) {
      const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
      const library = projectLibrary(root, new GitRepository(new GitCli(root)));
      server.middlewares.use((request, response, next) => {
        handleLibraryRequest(library, request.url ?? "").then((answer) => {
          if (answer === null) return next();
          response.statusCode = answer.status;
          response.setHeader("Content-Type", answer.contentType);
          response.end(answer.body);
        }, next);
      });
    },
  };
}

// The production build is loaded by the VS Code extension from a fixed path, so file names
// carry no content hash: the extension's HTML references main.js and main.css directly.
export default defineConfig({
  plugins: [react(), recordingLibrary()],
  base: "./",
  build: {
    outDir: "../extension/dist/webview",
    emptyOutDir: true,
    sourcemap: true,
    // three.js and React Flow make a large bundle; it is loaded from disk
    // by the webview, never over a network, so splitting it buys nothing.
    chunkSizeWarningLimit: 2500,
    rollupOptions: {
      input: "index.html",
      output: {
        entryFileNames: "main.js",
        chunkFileNames: "[name].js",
        assetFileNames: "main.[ext]",
      },
    },
  },
  server: { fs: { allow: ["../.."] } },
});
