// Where the boxes a person moved are kept: .runshape/arrangement.json, beside the recordings.
// The visualizer owns the format; this only reads and writes the text (the session's
// ArrangementStore port, by shape). Not committed: an arrangement is one person's reading aid.
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";

const FILE = "arrangement.json";
const WRITING = `${FILE}.writing`;
/** Far past any real arrangement (a few levels of tens of boxes is a few kilobytes): more is refused unread. */
export const MAX_ARRANGEMENT_BYTES = 1024 * 1024;

export class ArrangementFile {
  readonly where = join(".runshape", FILE);
  private readonly directory: string;

  constructor(projectRoot: string) {
    this.directory = join(projectRoot, ".runshape");
  }

  /**
   * Null when there's none yet. A link in its place, anything but a plain file, or a file too
   * big is refused (thrown), never followed or read: whoever put it there chose where it points.
   */
  async read(): Promise<string | null> {
    const path = join(this.directory, FILE);
    const entry = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (entry === null) return null;
    if (!entry.isFile()) throw new Error(`${this.where} isn't a plain file (a link or a folder): not read`);
    if (entry.size > MAX_ARRANGEMENT_BYTES) throw new Error(`${this.where} is over ${MAX_ARRANGEMENT_BYTES} bytes: not read`);
    // O_NOFOLLOW: if it became a link since the check, opening fails rather than following it.
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      return await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  }

  /**
   * Written beside it, then moved over it: a crash mid-write never leaves half a file. Whatever
   * was left at the side path (a link someone planted) is removed, not written through: the new
   * file is created exclusively, which fails on anything already there.
   */
  async write(text: string): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const writing = join(this.directory, WRITING);
    await rm(writing, { force: true });
    const handle = await open(writing, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    try {
      await handle.writeFile(text, "utf8");
    } finally {
      await handle.close();
    }
    await rename(writing, join(this.directory, FILE));
  }
}
