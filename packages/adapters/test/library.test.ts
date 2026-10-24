/**
 * The recordings a project has, and what it could record next. Each commit is recorded once,
 * into .runshape/recordings/<commit>; the working tree into .runshape/recordings/working,
 * replaced each time. Any two can then be compared. The library answers "what can I look
 * at, and what could I diff against?": the recordings, the branches and their tips, and which
 * tips are recorded already.
 *
 * Tested against a real git repository made for each test, not a fake git.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { GitCli, GitRepository, projectLibrary } from "../src";
import { metadata, recordAt, repository } from "./repository";

describe("RecordingLibrary", () => {
  test("an overview: the working tree, the recordings newest first, and each branch tip, recorded or not", async () => {
    const { root, commits } = repository();
    const directory = join(root, ".runshape", "recordings");
    recordAt(directory, metadata(commits.second!.slice(0, 12), commits.second!, "Second", "2026-10-02T09:00:00Z"));
    recordAt(directory, metadata("working", commits.third!, "Feature work", "2026-10-02T10:00:00Z", { branch: "feature", dirty: true }));
    writeFileSync(join(root, "file.txt"), "uncommitted");

    const overview = await projectLibrary(root, new GitRepository(new GitCli(root))).overview();

    expect({
      working: overview.working,
      recordings: overview.recordings.map((r) => `${r.id} ${r.subject}${r.dirty ? " (uncommitted changes)" : ""}`),
      refs: overview.refs.map((ref) => `${ref.name} ${ref.kind}${ref.current ? " (checked out)" : ""}: ${ref.subject} -> ${ref.recordingId ?? "not recorded"}`),
    }).toEqual({
      working: { branch: "feature", commit: commits.third, dirty: true },
      recordings: ["working Feature work (uncommitted changes)", `${commits.second!.slice(0, 12)} Second`],
      refs: [
        "feature branch (checked out): Feature work -> not recorded",
        `main branch: Second -> ${commits.second!.slice(0, 12)}`,
        "origin/main remote: First -> not recorded",
      ],
    });
  });

  test("a directory that isn't a recording (half written, or someone else's) is skipped, not fatal", async () => {
    const { root, commits } = repository();
    const directory = join(root, ".runshape", "recordings");
    // Its metadata written, then interrupted before it was moved into place.
    recordAt(directory, metadata(".incoming-abc", commits.first!, "First", "2026-10-02T09:00:00Z"));
    const broken = commits.second!.slice(0, 12);
    mkdirSync(join(directory, broken), { recursive: true });
    writeFileSync(join(directory, broken, "recording.json"), "{not json");
    // The folder name is the recording's id: metadata claiming another (a path, say) isn't
    // believed, or forgetting it would delete wherever it points (second-model review).
    recordAt(directory, metadata("aaaaaaaaaaaa", commits.first!, "First", "2026-10-02T09:00:00Z"));
    writeFileSync(join(directory, "aaaaaaaaaaaa", "recording.json"), JSON.stringify(metadata("../../victim", commits.first!, "First", "2026-10-02T09:00:00Z")));
    recordAt(directory, metadata("notes", commits.first!, "First", "2026-10-02T09:00:00Z"));

    const overview = await projectLibrary(root, new GitRepository(new GitCli(root))).overview();

    expect({ recordings: overview.recordings, problems: [...overview.problems].sort() }).toEqual({
      recordings: [],
      problems: [
        `${broken}: recording.json can't be read (Expected property name or '}' in JSON at position 1 (line 1 column 2))`,
        'aaaaaaaaaaaa: recording.json says it is "../../victim"',
      ],
    });
  });

  test("with no recordings directory yet, there's nothing recorded and every tip is recordable", async () => {
    const { root } = repository();

    // A new file not added yet is still in the tree the tests run against.
    writeFileSync(join(root, "new.test.ts"), "");

    const overview = await projectLibrary(root, new GitRepository(new GitCli(root))).overview();

    expect({ recordings: overview.recordings.length, unrecorded: overview.refs.filter((ref) => ref.recordingId === null).length, dirty: overview.working.dirty }).toEqual({
      recordings: 0,
      unrecorded: 3,
      dirty: true,
    });
  });
});

describe("the pull requests' morning list", () => {
  // review-requests leaves .runshape/reviews/requested.json; the recordings page shows it first
  // (the dev server's routes serve it: packages/webview/test/library-routes.test.ts).
  test("the overview carries the latest list of PRs asking for review", async () => {
    const { root } = repository();
    const index = { format: "runshape-requested-reviews", version: 1, createdAt: "2026-10-16T03:00:00Z", pullRequests: [{ number: 7, title: "Teach orders to refuse", review: "aaaaaaaaaaaa..bbbbbbbbbbbb" }] };
    mkdirSync(join(root, ".runshape", "reviews"), { recursive: true });
    writeFileSync(join(root, ".runshape", "reviews", "requested.json"), JSON.stringify(index));

    const overview = await projectLibrary(root, new GitRepository(new GitCli(root))).overview();

    expect(overview.requested?.pullRequests.map((pr) => `#${pr.number} ${pr.title} -> ${pr.review}`)).toEqual(["#7 Teach orders to refuse -> aaaaaaaaaaaa..bbbbbbbbbbbb"]);
  });

  test("before review-requests has run there's no list, which isn't an error", async () => {
    const { root } = repository();

    expect((await projectLibrary(root, new GitRepository(new GitCli(root))).overview()).requested).toBeNull();
  });
});
