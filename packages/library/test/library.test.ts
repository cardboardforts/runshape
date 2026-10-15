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

import { GitCli, RecordingLibrary, RecordingMetadata, serveLibraryFile } from "../src";
import { repository } from "./repository";

function recordAt(library: string, metadata: RecordingMetadata): void {
  mkdirSync(join(library, metadata.id, "run"), { recursive: true });
  writeFileSync(join(library, metadata.id, "recording.json"), JSON.stringify(metadata));
  writeFileSync(join(library, metadata.id, "latest.json"), JSON.stringify({ run: "run" }));
  writeFileSync(join(library, metadata.id, "run", "manifest.json"), "{}");
}

function metadata(id: string, commit: string, subject: string, recordedAt: string, extra: Partial<RecordingMetadata> = {}): RecordingMetadata {
  return { id, commit, subject, committedAt: "2026-10-01T10:00:00Z", branch: null, dirty: false, recordedAt, recorder: "recorder-ts", tests: { total: 3, failed: 0 }, ...extra };
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
    const { root } = repository();
    const directory = join(root, ".runshape", "recordings");
    mkdirSync(join(directory, ".incoming-abc"), { recursive: true });
    mkdirSync(join(directory, "broken"), { recursive: true });
    writeFileSync(join(directory, "broken", "recording.json"), "{not json");

    const overview = await new RecordingLibrary(directory, new GitCli(root)).overview();

    expect({ recordings: overview.recordings, problems: overview.problems }).toEqual({
      recordings: [],
      problems: [expect.stringMatching(/^broken: recording.json can't be read/)],
    });
  });

  test("with no recordings directory yet, there's nothing recorded and every tip is recordable", async () => {
    const { root } = repository();

    const overview = await new RecordingLibrary(join(root, ".runshape", "recordings"), new GitCli(root)).overview();

    expect({ recordings: overview.recordings.length, unrecorded: overview.refs.filter((ref) => ref.recordingId === null).length }).toEqual({ recordings: 0, unrecorded: 3 });
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
