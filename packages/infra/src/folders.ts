import { chmod, lstat, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Why a folder isn't only plain files: what's wrong, and where (relative to the folder). */
export class NotPlainFiles extends Error {
  constructor(
    readonly reason: "not-a-file" | "too-big" | "unreadable",
    readonly detail: string,
  ) {
    super(`${reason}: ${detail}`);
  }
}

/**
 * Every entry under the folder is a plain file or folder, and they add up to at most maxBytes:
 * a link would turn the next write or read there into one somewhere else.
 */
export async function assertPlainFiles(directory: string, maxBytes: number): Promise<void> {
  let total = 0;
  const walk = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) total += (await lstat(full)).size;
      else throw new NotPlainFiles("not-a-file", full.slice(directory.length + 1));
      if (total > maxBytes) throw new NotPlainFiles("too-big", `${maxBytes} bytes`);
    }
  };
  try {
    await walk(directory);
  } catch (error) {
    if (error instanceof NotPlainFiles) throw error;
    // A folder made unreadable (chmod 000), say: refused, not a crash.
    throw new NotPlainFiles("unreadable", error instanceof Error ? error.message : String(error));
  }
}

/**
 * Removes a folder whatever was done to it: one made unreadable (chmod 000, owned by the
 * person, so fixable) would otherwise stop every later run. Links are removed, never followed.
 */
export async function removeAnyway(path: string): Promise<void> {
  const entry = await lstat(path).catch(() => null);
  if (entry === null) return;
  if (entry.isDirectory()) {
    await chmod(path, 0o700).catch(() => {});
    for (const name of await readdir(path).catch(() => [] as string[])) await removeAnyway(join(path, name));
  }
  await rm(path, { recursive: true, force: true });
}

/**
 * Puts a finished folder where an older one may be: the older is set aside, not deleted, until
 * the new one is in place, and comes back if the move fails.
 */
export async function swapIntoPlace(finished: string, final: string, aside: string): Promise<void> {
  const hadOne = await rename(final, aside).then(() => true, () => false);
  try {
    await rename(finished, final);
  } catch (error) {
    if (hadOne) await rename(aside, final);
    throw error;
  }
  if (hadOne) await rm(aside, { recursive: true, force: true });
}

/** The lock is held by a process that's still running. */
export class LockHeld extends Error {
  constructor(
    readonly holder: number,
    readonly lockFile: string,
  ) {
    super(`process ${holder} holds ${lockFile}`);
  }
}

/** Runs `work` holding a lock file that names this process; one left by a process that's gone is taken over. */
export async function holdingLock<T>(lockFile: string, work: () => Promise<T>): Promise<T> {
  try {
    await writeFile(lockFile, String(process.pid), { flag: "wx" });
  } catch {
    const holder = Number((await readFile(lockFile, "utf8").catch(() => "")).trim());
    if (Number.isInteger(holder) && holder > 0 && isRunning(holder)) throw new LockHeld(holder, lockFile);
    await writeFile(lockFile, String(process.pid));
  }
  try {
    return await work();
  } finally {
    await rm(lockFile, { force: true });
  }
}

/** Whether a process exists: signal 0 checks without sending anything. */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, it's someone else's.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
