import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The production build is loaded by the VS Code extension from a fixed path, so file names
// carry no content hash: the extension's HTML references main.js and main.css directly.
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "../extension/dist/webview",
    emptyOutDir: true,
    sourcemap: true,
    // elkjs (the graph layout engine) is ~1.4MB on its own; the bundle is loaded from disk
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
