// Self-contained files (core bundled in) so CI can run them with plain `node`.
import { build } from "esbuild";

const common = { bundle: true, platform: "node", format: "esm", target: "node20", banner: { js: "#!/usr/bin/env node" }, logLevel: "warning" };
await build({ ...common, entryPoints: ["src/bin.ts"], outfile: "dist/runshape-review-md.mjs" });
await build({ ...common, entryPoints: ["src/runshape-bin.ts"], outfile: "dist/runshape.mjs" });
