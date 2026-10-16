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
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { GitCli, handleLibraryRequest, RecordingLibrary, RecordingMetadata, serveLibraryFile } from "../src";
import { repository } from "./repository";

function recordAt(library: string, metadata: RecordingMetadata): void {
  mkdirSync(join(library, metadata.id, "run"), { recursive: true });
  writeFileSync(join(library, metadata.id, "recording.json"), JSON.stringify(metadata));
  writeFileSync(join(library, metadata.id, "latest.json"), JSON.stringify({ run: "run" }));
  writeFileSync(join(library, metadata.id, "run", "manifest.json"), "{}");
}

function metadata(id: string, commit: string, subject: string, recordedAt: string, extra: Partial<RecordingMetadata> = {}): RecordingMetadata {
  return { id, commit, subject, committedAt: "2026-10-01T10:00:00Z", branch: null, dirty: false, recordedAt, recorder: "recorder-ts", recorderSource: "0123456789abcdef", tests: { total: 3, failed: 0 },
    architecture: { style: "hexagonal", rules: 0, declared: 0, inferred: 3, problem: null }, ...extra };
}

describe("RecordingLibrary", () => {
  test("an overview: the working tree, the recordings newest first, and each branch tip, recorded or not", async () => {
    const { root, commits } = repository();
    const directory = join(root, ".runshape", "recordings");
    recordAt(directory, metadata(commits.second!.slice(0, 12), commits.second!, "Second", "2026-10-02T09:00:00Z"));
    recordAt(directory, metadata("working", commits.third!, "Feature work", "2026-10-02T10:00:00Z", { branch: "feature", dirty: true }));
    writeFileSync(join(root, "file.txt"), "uncommitted");

    const overview = await new RecordingLibrary(directory, new GitCli(root)).overview();

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

    const overview = await new RecordingLibrary(directory, new GitCli(root)).overview();

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

    const overview = await new RecordingLibrary(join(root, ".runshape", "recordings"), new GitCli(root)).overview();

    expect({ recordings: overview.recordings.length, unrecorded: overview.refs.filter((ref) => ref.recordingId === null).length, dirty: overview.working.dirty }).toEqual({
      recordings: 0,
      unrecorded: 3,
      dirty: true,
    });
  });

  test("a ref resolves to its commit; a name git doesn't know is an error that says so", async () => {
    const { root, commits } = repository();
    const library = new RecordingLibrary(join(root, ".runshape", "recordings"), new GitCli(root));

    expect(await library.resolve("origin/main")).toEqual({ commit: commits.first, subject: "First", committedAt: "2026-10-01T10:00:00Z" });
    await expect(library.resolve("nope")).rejects.toThrowError("git doesn't know nope");
    // Passed as one argument, never through a shell, and never taken for an option.
    await expect(library.resolve("--output=/tmp/x")).rejects.toThrowError("git doesn't know --output=/tmp/x");
  });
});

describe("serveLibraryFile", () => {
  test("serves a recording's files, and nothing outside the recordings directory", async () => {
    const { root, commits } = repository();
    const directory = join(root, ".runshape", "recordings");
    const id = commits.second!.slice(0, 12);
    recordAt(directory, metadata(id, commits.second!, "Second", "2026-10-02T09:00:00Z"));
    writeFileSync(join(root, ".runshape", "secret.txt"), "not yours");

    const served = async (path: string) => {
      const response = await serveLibraryFile(directory, path);
      return `${response.status} ${response.status === 200 ? response.body : ""}`;
    };
    expect(
      await Promise.all([`${id}/latest.json`, `${id}/run/manifest.json`, `${id}/../secret.txt`, "../secret.txt", `${id}/run/nothing.json`, `${id}/run`].map(served)),
    ).toEqual(['200 {"run":"run"}', "200 {}", "404 ", "404 ", "404 ", "404 "]);
  });
});

describe("handleLibraryRequest (the demo's dev server)", () => {
  test("answers the overview and recordings' files under /__runshape/, and leaves every other URL alone", async () => {
    const { root, commits } = repository();
    const directory = join(root, ".runshape", "recordings");
    const id = commits.second!.slice(0, 12);
    recordAt(directory, metadata(id, commits.second!, "Second", "2026-10-02T09:00:00Z"));
    const library = new RecordingLibrary(directory, new GitCli(root));

    const answer = async (url: string) => {
      const response = await handleLibraryRequest(library, url);
      return response === null ? "not ours" : `${response.status} ${response.contentType}`;
    };
    const overview = await handleLibraryRequest(library, "/__runshape/library");

    expect(
      await Promise.all(["/__runshape/library", `/__runshape/recordings/${id}/latest.json`, "/__runshape/recordings/%2e%2e/secret", "/__runshape/recordings/%E0%A4%A", "/demo/index.html"].map(answer)),
    ).toEqual(["200 application/json", "200 application/json", "404 text/plain", "404 text/plain", "not ours"]);
    expect(JSON.parse(overview!.body).recordings.map((r: RecordingMetadata) => r.id)).toEqual([id]);
  });

  test("when git fails, the overview is an error that says what failed, not an empty library", async () => {
    const directory = join(tmpdir(), "runshape-not-a-repository");
    mkdirSync(directory, { recursive: true });
    const library = new RecordingLibrary(join(directory, "recordings"), new GitCli(directory));

    const response = await handleLibraryRequest(library, "/__runshape/library");

    expect({ status: response?.status, body: response?.body }).toEqual({ status: 500, body: expect.stringMatching(/^git .*not a git repository/) });
  });
});

describe("the pull requests' morning list", () => {
  // review-requests leaves .runshape/reviews/requested.json; the recordings page shows it first.
  test("the overview carries the latest list of PRs asking for review, and their reviews' files are served", async () => {
    const { root } = repository();
    const reviews = join(root, ".runshape", "reviews");
    mkdirSync(join(reviews, "aaaaaaaaaaaa..bbbbbbbbbbbb"), { recursive: true });
    writeFileSync(join(reviews, "aaaaaaaaaaaa..bbbbbbbbbbbb", "review.md"), "## Behaviour changes (Runshape)\n");
    const index = { format: "runshape-requested-reviews", version: 1, createdAt: "2026-10-16T03:00:00Z", pullRequests: [{ number: 7, title: "Teach orders to refuse", review: "aaaaaaaaaaaa..bbbbbbbbbbbb" }] };
    writeFileSync(join(reviews, "requested.json"), JSON.stringify(index));
    const library = new RecordingLibrary(join(root, ".runshape", "recordings"), new GitCli(root));

    const overview = await library.overview();
    const served = await handleLibraryRequest(library, "/__runshape/reviews/aaaaaaaaaaaa..bbbbbbbbbbbb/review.md");
    const escaped = await handleLibraryRequest(library, "/__runshape/reviews/../recordings/x");

    expect({
      requested: overview.requested?.pullRequests.map((pr) => `#${pr.number} ${pr.title} -> ${pr.review}`),
      served: [served?.status, served?.contentType, served?.body],
      escaped: escaped?.status,
    }).toEqual({
      requested: ["#7 Teach orders to refuse -> aaaaaaaaaaaa..bbbbbbbbbbbb"],
      served: [200, "text/markdown; charset=utf-8", "## Behaviour changes (Runshape)\n"],
      escaped: 404,
    });
  });

  test("before review-requests has run there's no list, which isn't an error", async () => {
    const { root } = repository();

    expect((await new RecordingLibrary(join(root, ".runshape", "recordings"), new GitCli(root)).overview()).requested).toBeNull();
  });
});
