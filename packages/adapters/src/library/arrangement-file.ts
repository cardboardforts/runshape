// Where the boxes a person moved are kept: .runshape/arrangement.json, beside the recordings.
// The visualizer owns the format; this only reads and writes the text (the session's
// ArrangementStore port, by shape). Not committed: an arrangement is one person's reading aid.
import { join } from "node:path";

import { NodeFiles } from "@runshape/infra";

const FILE = "arrangement.json";

export class ArrangementFile {
  readonly where = join(".runshape", FILE);
  private readonly files: NodeFiles;

  constructor(projectRoot: string) {
    this.files = new NodeFiles(join(projectRoot, ".runshape"));
  }

  /** Null when there's none yet; any other failure (unreadable, a folder in its place) is thrown. */
  async read(): Promise<string | null> {
    try {
      return await this.files.readText(FILE);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  /** Written beside it, then moved over it: a crash mid-write never leaves half a file. */
  async write(text: string): Promise<void> {
    await this.files.writeText(`${FILE}.writing`, text);
    await this.files.move(`${FILE}.writing`, FILE);
  }
}
