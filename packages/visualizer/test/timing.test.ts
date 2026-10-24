/**
 * Where the time goes, per function, from the span timestamps every recording already has.
 * Total is wall time inclusive (an async method's awaits included; a recursive call isn't
 * counted twice); self is total minus the project code it called, so database and library
 * time land in self. Tracing slows project code, so compare these with each other, not
 * with production latencies.
 */
import { describe, expect, test } from "vitest";

import { buildComponentView } from "../src";
import { formatMicros } from "@runshape/views";
import { loadFixtureRun } from "../../core/test/fixtures";

describe("time per function", () => {
  test("FastAPI's users repository: creating a user is slow for what it calls (password hashing); lookups are their own queries", async () => {
    const run = await loadFixtureRun("fastapi");

    const view = buildComponentView(run, "class:app.db.repositories.users.UsersRepository", { collapseMiddleware: true });

    const rows = view.functions
      .filter((fn) => fn.calls > 0)
      .sort((a, b) => b.totalUs - a.totalUs)
      .map((fn) => `${fn.name.padEnd(24)} ${String(fn.calls).padStart(3)} calls  total ${formatMicros(fn.totalUs).padStart(8)}  self ${formatMicros(fn.selfUs).padStart(8)}`);
    expect(rows).toMatchInlineSnapshot(`
      [
        "create_user                9 calls  total   1.68 s  self    14 ms",
        "get_user_by_username      33 calls  total   8.8 ms  self   8.7 ms",
        "get_user_by_email          2 calls  total   712 µs  self   706 µs",
        "connection                53 calls  total   102 µs  self   102 µs",
        "__init__                  15 calls  total    43 µs  self    43 µs",
      ]
    `);
    expect(view.functions.every((fn) => fn.selfUs <= fn.totalUs)).toBe(true);
  });
});
