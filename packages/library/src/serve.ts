import { readFile, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";

export interface ServedFile {
  status: 200 | 404;
  body: string;
}

/**
 * A file inside the recordings directory, by its path relative to it, for the demo's dev
 * server: nothing outside it, whatever "..", and no directory listings.
 */
export async function serveLibraryFile(directory: string, relativePath: string): Promise<ServedFile> {
  const root = resolve(directory);
  const target = resolve(root, relativePath);
  if (!target.startsWith(root + sep)) return { status: 404, body: "" };
  try {
    if (!(await stat(target)).isFile()) return { status: 404, body: "" };
    return { status: 200, body: await readFile(target, "utf8") };
  } catch {
    return { status: 404, body: "" };
  }
}
