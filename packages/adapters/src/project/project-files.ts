// The project's own working tree, as the recordings workflow reads and writes it (core's
// ProjectFiles): folder guides' READMEs, opening comments, the working tree's runshape.json.
import { lstat, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";

import { ProjectFiles, Readme } from "@runshape/kernel";

const README_FILE = "README.md";

export class NodeProjectFiles implements ProjectFiles {
  constructor(private readonly root: string) {}

  isPlainFile(path: string): Promise<boolean> {
    return lstat(join(this.root, path)).then((s) => s.isFile(), () => false);
  }

  /** Only a plain file inside the project, however the recording names the folder. */
  async readme(folder: string): Promise<Readme> {
    const directory = join(this.root, folder);
    if (!(await stat(directory).then((s) => s.isDirectory(), () => false))) return { kind: "no-folder" };
    const file = join(directory, README_FILE);
    if (!(await this.inside(directory)) || (await lstat(file).then((s) => !s.isFile(), () => false))) return { kind: "not-plain" };
    try {
      return { kind: "readme", text: await readFile(file, "utf8") };
    } catch (error) {
      // Only a missing README is "none"; one that can't be read isn't overwritten.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "readme", text: null };
      return { kind: "unreadable", reason: (error as Error).message };
    }
  }

  async writeReadme(folder: string, text: string): Promise<void> {
    await writeFile(join(this.root, folder, README_FILE), text);
  }

  async readTextIfPresent(path: string): Promise<string | null> {
    try {
      return await readFile(join(this.root, path), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  readBytes(path: string): Promise<Uint8Array | null> {
    return readFile(join(this.root, path)).then((bytes) => bytes, () => null);
  }

  /** Whether a folder, links resolved, is the project or inside it. */
  private async inside(directory: string): Promise<boolean> {
    const [project, folder] = await Promise.all([realpath(this.root), realpath(directory)]);
    return folder === project || folder.startsWith(`${project}${sep}`);
  }
}
