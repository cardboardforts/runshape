import { join } from "node:path";

import { Library, LibraryOverview, SANDBOX_SUFFIX, WORKING_TREE_ID } from "@runshape/kernel";
import { NodeFiles } from "@runshape/infra";

import { GitRepository } from "../git/git-repository";
import { RecordingStore } from "./recording-store";
import { ReviewStore } from "./review-store";

/** A project's library as runshape keeps it: .runshape/recordings, and the reviews beside them. */
export function projectLibrary(root: string, repository: GitRepository): RecordingLibrary {
  const runshape = join(root, ".runshape");
  const REVIEWS = join(".runshape", "reviews");
  return new RecordingLibrary(new RecordingStore(new NodeFiles(join(runshape, "recordings"))), repository, new ReviewStore(new NodeFiles(join(root, REVIEWS)), REVIEWS));
}

/** A project's recordings (.runshape/recordings) and the git refs they could be compared against. */
export class RecordingLibrary implements Library {
  constructor(
    readonly store: RecordingStore,
    private readonly repository: GitRepository,
    readonly reviews: ReviewStore,
  ) {}

  async overview(): Promise<LibraryOverview> {
    const [{ recordings, problems }, refs, working, requested] = await Promise.all([this.store.list(), this.repository.branchTips(), this.repository.workingTree(), this.reviews.requested()]);
    // A commit recorded both here and in the sandbox: its branches point at the one made here.
    const committed = new Map<string, string>();
    for (const r of recordings) {
      if (r.id === WORKING_TREE_ID) continue;
      if (!committed.has(r.commit) || !r.id.endsWith(SANDBOX_SUFFIX)) committed.set(r.commit, r.id);
    }
    return {
      working,
      recordings,
      refs: refs.map((ref) => ({ ...ref, current: ref.kind === "branch" && ref.name === working.branch, recordingId: committed.get(ref.commit) ?? null })),
      problems,
      requested,
    };
  }
}
