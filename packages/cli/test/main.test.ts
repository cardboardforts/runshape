import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { reviewFromDirectory } from "../src/main";

const FIXTURES = join(import.meta.dirname, "..", "..", "core", "test", "fixtures");

describe("runshape-review-md", () => {
  test("reviews the latest recording against the previous one", async () => {
    const markdown = await reviewFromDirectory(join(FIXTURES, "fastapi-slug-refactor"));

    expect(markdown.split("\n").slice(0, 5)).toEqual([
      "## Behaviour changes (Runshape)",
      "",
      "4 tests recorded on the base and on this branch.",
      "",
      "**2 tests still pass but now run differently** — the changes a green CI won't show you.",
    ]);
  });

  test("with a single recording it says how to make a base", async () => {
    await expect(reviewFromDirectory(join(FIXTURES, "django"))).rejects.toThrowError(/run runshape-review --base <ref>/);
  });
});
