/**
 * The demo dev server's routes for the recording library (dev-server/library-routes.ts): the
 * overview, and recordings' and reviews' files, read-only, and nothing outside them. Tested
 * against a real git repository and real files, made for each test.
 */
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import type { RecordingMetadata } from "@runshape/kernel";
import { GitCli, GitRepository, projectLibrary } from "@runshape/adapters";
import { metadata, recordAt, repository } from "@runshape/adapters/test/repository";
import { handleLibraryRequest, serveLibraryFile } from "../dev-server/library-routes";

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

describe("a link inside a recording (second-model review)", () => {
  test("isn't served when it leads outside the recordings: the dev server would hand out any file", async () => {
    const { root, commits } = repository();
    const directory = join(root, ".runshape", "recordings");
    const id = commits.second!.slice(0, 12);
    recordAt(directory, metadata(id, commits.second!, "Second", "2026-10-02T09:00:00Z"));
    writeFileSync(join(root, ".runshape", "secret.json"), '{"token": "not yours"}');
    symlinkSync("../../secret.json", join(directory, id, "leak.json"));

    expect((await serveLibraryFile(directory, `${id}/leak.json`)).status).toBe(404);
  });
});

describe("handleLibraryRequest (the demo's dev server)", () => {
  test("answers the overview and recordings' files under /__runshape/, and leaves every other URL alone", async () => {
    const { root, commits } = repository();
    const directory = join(root, ".runshape", "recordings");
    const id = commits.second!.slice(0, 12);
    recordAt(directory, metadata(id, commits.second!, "Second", "2026-10-02T09:00:00Z"));
    const library = projectLibrary(root, new GitRepository(new GitCli(root)));

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
    const library = projectLibrary(directory, new GitRepository(new GitCli(directory)));

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
    const library = projectLibrary(root, new GitRepository(new GitCli(root)));

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
});
