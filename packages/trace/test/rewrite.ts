// Staging a change from real data: a recording rewritten as if code had moved or its lines
// had changed. Shared by the trace module's tests (moves, threads).
import type { TraceFiles } from "@runshape/kernel";

/** What to change in a recording, to stage a move from real data. */
export interface Rewrite {
  /** Whole modules renamed (the module itself and the classes in it). */
  modules?: Record<string, string>;
  /** Single functions moved: "module:qualname" -> new module. */
  functions?: Record<string, string>;
  /** Object classes renamed, by full dotted name. */
  classes?: Record<string, string>;
  /** Source lines rewritten in the manifest's sources: file -> line number -> new text. */
  lines?: Record<string, Record<number, string>>;
  keepSources?: boolean;
}

export function rewritten(files: TraceFiles, rewrite: Rewrite): TraceFiles {
  const modules = rewrite.modules ?? {};
  const renameModule = (name: string) => modules[name] ?? name;
  const renameDotted = (name: string) => {
    for (const [from, to] of Object.entries(modules)) if (name.startsWith(`${from}.`)) return to + name.slice(from.length);
    return rewrite.classes?.[name] ?? name;
  };
  const moveFunction = (fn: { module: string; qualname: string }) => {
    fn.module = rewrite.functions?.[`${fn.module}:${fn.qualname}`] ?? renameModule(fn.module);
  };
  return {
    async readText(path) {
      const data = JSON.parse(await files.readText(path));
      if (path.endsWith("manifest.json")) {
        for (const fn of data.catalog) moveFunction(fn);
        for (const route of data.framework?.routes ?? []) route.handler = renameDotted(route.handler);
        for (const [file, edits] of Object.entries(rewrite.lines ?? {})) {
          for (const [line, text] of Object.entries(edits)) data.sources[file][Number(line) - 1] = text;
        }
        if (rewrite.keepSources === false) delete data.sources;
      } else if (path.includes("/scenarios/")) {
        for (const fn of data.functions) moveFunction(fn);
        for (const event of data.events) if (event[0] === "O") event[3] = renameDotted(event[3]);
      }
      return JSON.stringify(data);
    },
  };
}
