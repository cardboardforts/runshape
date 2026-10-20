import { join } from "node:path";

import { holdingLock, NodeFiles, removeAnyway, swapIntoPlace } from "@runshape/infra";

import type { RecordingMetadata } from "./library";

export const WORKING_TREE_ID = "working";
export const METADATA_FILE = "recording.json";
/** As many hex digits as a recording's directory name keeps. */
const RECORDING_ID_LENGTH = 12;
/** A directory still being written; renamed into place when its recording is complete. */
export const INCOMING_PREFIX = ".incoming-";

/** Marks a commit's recording made in the sandbox: one of its own, beside one made on this machine. */
export const SANDBOX_SUFFIX = "-sandbox";

/** A recording's folder name: a commit's first hex digits (and the sandbox's mark), or the working tree's. */
export const RECORDING_ID = new RegExp(`^([0-9a-f]{${RECORDING_ID_LENGTH}}(${SANDBOX_SUFFIX})?|${WORKING_TREE_ID})$`);

export function recordingIdFor(commit: string, sandboxed = false): string {
  return `${commit.slice(0, RECORDING_ID_LENGTH)}${sandboxed ? SANDBOX_SUFFIX : ""}`;
}

/** Where each recording keeps its commit's placements, and the runshape.json they came from. */
export const ARCHITECTURE_FILE = "architecture.json";

/** Taken while recording or forgetting, so two runs can't write over each other's recordings. */
export const LOCK_FILE = ".lock";
/** A recording being replaced, kept until its replacement is in place. */
const REPLACED_PREFIX = ".replaced-";
/** The commit's own runshape.json, kept with its recording as it was. */
export const KEPT_RULES_FILE = "runshape.json";

/**
 * The recordings a project keeps (.runshape/recordings): a folder per commit, and one for the
 * working tree, each a traces directory with recording.json beside it. A recording is written
 * in a hidden folder of its own and moved into place only once it's complete.
 */
export class RecordingStore {
  constructor(private readonly files: NodeFiles) {}

  get directory(): string {
    return this.files.root;
  }

  /** Every recording, newest first, and the folders that look like one but can't be read. */
  async list(): Promise<{ recordings: RecordingMetadata[]; problems: string[] }> {
    let names: string[];
    try {
      names = await this.files.list();
    } catch {
      return { recordings: [], problems: [] }; // a recordings folder that can't be read lists as empty (none yet is [] already)
    }
    const recordings: RecordingMetadata[] = [];
    const problems: string[] = [];
    for (const name of names) {
      // Hidden ones are still being written (INCOMING_PREFIX); other names aren't recordings.
      if (!RECORDING_ID.test(name)) continue;
      let text: string;
      try {
        text = await this.files.readText(`${name}/${METADATA_FILE}`);
      } catch {
        continue; // not a recording: a stray directory or file
      }
      let metadata: RecordingMetadata;
      try {
        metadata = JSON.parse(text) as RecordingMetadata;
      } catch (error) {
        problems.push(`${name}: ${METADATA_FILE} can't be read (${error instanceof Error ? error.message : String(error)})`);
        continue;
      }
      // The folder is the id: anything that acts on a recording (forget, a link) uses it.
      if (metadata.id !== name) {
        problems.push(`${name}: ${METADATA_FILE} says it is ${JSON.stringify(metadata.id)}`);
        continue;
      }
      recordings.push(metadata);
    }
    recordings.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
    return { recordings, problems };
  }

  async recording(id: string): Promise<RecordingMetadata | undefined> {
    return (await this.list()).recordings.find((r) => r.id === id);
  }

  pathOf(id: string): string {
    return join(this.directory, id);
  }

  /** A recording's files: a traces directory, for trace's TraceDirectory to read. */
  filesOf(id: string): NodeFiles {
    return new NodeFiles(this.pathOf(id));
  }

  /** The runshape.json kept with a recording; null when its commit had none. */
  async keptRules(id: string): Promise<string | null> {
    return this.filesOf(id).readText(KEPT_RULES_FILE).catch(() => null);
  }

  /**
   * Runs `work` holding the store's lock (LockHeld when a live process has it). What an
   * interrupted run left half-written is cleared first: nothing else writes while it's held.
   */
  async exclusively<T>(work: () => Promise<T>, couldNotClear: (name: string, error: Error) => void): Promise<T> {
    await this.files.makeFolder(); // for the lock to go in
    return holdingLock(join(this.directory, LOCK_FILE), async () => {
      for (const name of await this.files.list()) {
        if (!name.startsWith(INCOMING_PREFIX) && !name.startsWith(REPLACED_PREFIX)) continue;
        // Whatever a sandboxed run left (an unreadable folder, say) mustn't stop this one.
        await removeAnyway(join(this.directory, name)).catch((error: Error) => couldNotClear(name, error));
      }
      return work();
    });
  }

  /** A hidden folder for a new recording of `id`: the recorder writes into it. */
  async begin(id: string): Promise<IncomingRecording> {
    const incoming = new IncomingRecording(join(this.directory, `${INCOMING_PREFIX}${id}`), id, this);
    await incoming.files.makeFolder();
    return incoming;
  }

  /** Puts a finished recording in place; the one it replaces is kept until then. */
  async commit(incoming: IncomingRecording, metadata: RecordingMetadata): Promise<void> {
    await incoming.files.writeText(METADATA_FILE, `${JSON.stringify(metadata, null, 2)}\n`);
    await swapIntoPlace(incoming.directory, this.pathOf(incoming.id), join(this.directory, `${REPLACED_PREFIX}${incoming.id}`));
  }

  async forget(id: string): Promise<void> {
    await this.files.remove(id);
  }

  /** Moves a recording to another id, saying so in its metadata; if that id is taken, this one just goes. */
  async move(id: string, to: string): Promise<void> {
    if (await this.filesOf(to).readText(METADATA_FILE).then(() => true, () => false)) {
      await removeAnyway(this.pathOf(id));
      return;
    }
    await this.files.move(id, to);
    const files = this.filesOf(to);
    const metadata = JSON.parse(await files.readText(METADATA_FILE)) as RecordingMetadata;
    await files.writeText(METADATA_FILE, `${JSON.stringify({ ...metadata, id: to }, null, 2)}\n`);
  }
}

/** A recording being written: complete only once the store commits it. */
export class IncomingRecording {
  readonly files: NodeFiles;

  constructor(
    readonly directory: string,
    readonly id: string,
    private readonly store: RecordingStore,
  ) {
    this.files = new NodeFiles(directory);
  }

  /** The commit's runshape.json as it was, and where its rules put each class. */
  async keepArchitecture(rulesText: string | null, architecture: unknown): Promise<void> {
    if (rulesText !== null) await this.files.writeText(KEPT_RULES_FILE, rulesText);
    await this.files.writeText(ARCHITECTURE_FILE, `${JSON.stringify(architecture, null, 2)}\n`);
  }

  commit(metadata: RecordingMetadata): Promise<void> {
    return this.store.commit(this, metadata);
  }

  /** Clears what it wrote; the next run clears anything left, and says if it can't. */
  async discard(): Promise<void> {
    await removeAnyway(this.directory).catch(() => {});
  }
}
