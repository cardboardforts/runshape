import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { safeSegments } from "./paths";

/** Text files under one directory on this machine, by path relative to it. */
export class NodeFiles {
  constructor(readonly root: string) {}

  async readText(relativePath: string): Promise<string> {
    return readFile(this.pathOf(relativePath), "utf8");
  }

  /** Writes the whole file, making its folder first. */
  async writeText(relativePath: string, text: string): Promise<void> {
    const path = this.pathOf(relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  }

  /** The names in a folder ("" for the root); none when the folder doesn't exist. */
  async list(relativePath = ""): Promise<string[]> {
    try {
      return await readdir(this.pathOf(relativePath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  /** Removes a file, or a folder and everything in it; nothing there is fine. */
  async remove(relativePath: string): Promise<void> {
    const segments = safeSegments(relativePath);
    if (segments.length === 0) throw new Error(`refusing to remove the whole of ${this.root}`);
    await rm(join(this.root, ...segments), { recursive: true, force: true });
  }

  private pathOf(relativePath: string): string {
    return join(this.root, ...safeSegments(relativePath));
  }
}
