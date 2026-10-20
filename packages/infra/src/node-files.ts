import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { safeSegments } from "./paths";

/** Text files under one directory on this machine, by path relative to it. */
export class NodeFiles {
  constructor(readonly root: string) {}

  async readText(relativePath: string): Promise<string> {
    return readFile(join(this.root, ...safeSegments(relativePath)), "utf8");
  }
}
