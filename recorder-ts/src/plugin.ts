// The vite plugin that instruments a project's own source as vitest loads it.
import { relative, sep } from "node:path";

import { instrument } from "./instrument";

/** `include`: directories relative to `root` whose .ts/.tsx files are recorded. */
export function runshapeInstrument(root: string, include: string[]) {
  return {
    name: "runshape-instrument",
    enforce: "pre" as const,
    transform(code: string, id: string) {
      const file = relative(root, id.split("?")[0]!).split(sep).join("/");
      if (!/\.tsx?$/.test(file) || file.endsWith(".d.ts")) return null;
      if (!include.some((directory) => file.startsWith(`${directory}/`))) return null;
      return { code: instrument(file, code).code, map: null };
    },
  };
}
