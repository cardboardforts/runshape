import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import { safeSegments } from "./paths";

/** Text files under one directory on this machine, by path relative to it. */
export class NodeFiles {
  constructor(readonly root: string) {}

  async readText(relativePath: string): Promise<string> {
    return readFile(this.pathOf(relativePath), "utf8");
  }

  /**
   * Reads a file only if it's inside the root once links are followed: a link someone else's
   * code left (a sandboxed recording's) can't make it read a file outside. A folder fails to
   * read like a missing file.
   */
  async readTextWithin(relativePath: string): Promise<string> {
    const root = resolve(this.root);
    const target = resolve(root, relativePath);
    if (!target.startsWith(root + sep)) throw new Error(`refusing a path outside its directory: ${relativePath}`);
    const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)]);
    if (!realTarget.startsWith(realRoot + sep)) throw new Error(`refusing a link out of its directory: ${relativePath}`);
    return readFile(realTarget, "utf8");
  }

  /** Writes the whole file, making its folder first. */
  async writeText(relativePath: string, text: string): Promise<void> {
    const path = this.pathOf(relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  }

  /**
   * Writes the whole file so a reader sees the old text or the new, never half: written beside
   * it under a name of its own, then renamed over it (a rename within a folder is atomic).
   */
  async replaceText(relativePath: string, text: string): Promise<void> {
    const path = this.pathOf(relativePath);
    await mkdir(dirname(path), { recursive: true });
    const partial = `${path}.${process.pid}.${randomUUID()}.partial`;
    try {
      await writeFile(partial, text);
      await rename(partial, path);
    } catch (error) {
      await rm(partial, { force: true });
      throw error;
    }
  }

  /** Makes a folder ("" for the root itself), and any above it. */
  async makeFolder(relativePath = ""): Promise<void> {
    await mkdir(this.pathOf(relativePath), { recursive: true });
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

  /** Moves a file or folder to another path under the root. */
  async move(from: string, to: string): Promise<void> {
    await rename(this.pathOf(from), this.pathOf(to));
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
