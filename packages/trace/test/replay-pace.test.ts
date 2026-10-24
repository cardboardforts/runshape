/**
 * Replaying at the recording's own pace: each hop plays for as long as the app spent before
 * the next hop, log-compressed so a 1 µs hop and a 200 ms password hash are both watchable.
 * The times include tracing overhead (project code is traced line by line, so it looks
 * slower than it runs); external calls are close to real. Read the pace as relative.
 */
import { describe, expect, test } from "vitest";

import { Phase } from "@runshape/kernel";
import { buildReplay, describeGap, formatMicros, ReplayPace, stepDurationsMs } from "../src";
import { loadFixtureRun } from "../../kernel/test/fixtures";

describe("replay pace", () => {
  test("registering a user: the query and the password hash take the time, not the plumbing", async () => {
    const run = await loadFixtureRun("fastapi");
    const scenario = run.scenario("tests/test_api/test_routes/test_registration.py::test_user_success_registration")!;
    const steps = buildReplay(scenario, [Phase.Call], { collapseMiddleware: true });

    const recorded = stepDurationsMs(steps, ReplayPace.Recorded);
    const even = stepDurationsMs(steps, ReplayPace.Even);

    const rows = steps.map((step, i) => `${String(recorded[i]).padStart(5)} ms  ${describeGap(steps, i).padStart(9)}  ${step.kind.padEnd(8)} ${step.label.split("\n")[0]!.slice(0, 48)}`);
    // Every hop shown, slowest first: what a viewer would notice as pauses.
    const slowest = rows.map((row, i) => ({ row, ms: recorded[i]! })).sort((a, b) => b.ms - a.ms).slice(0, 8).map((r) => r.row);
    expect(slowest).toMatchInlineSnapshot(`
      [
        " 1460 ms     185 ms  call     verify_password",
        " 1458 ms     183 ms  call     get_password_hash",
        "  836 ms     742 µs  external SELECT id,",
        "  835 ms     731 µs  external INSERT INTO users (username, email, salt, hashed",
        "  817 ms     624 µs  call     APIRouter",
        "  809 ms     584 µs  return   get_repository.<locals>._get_repo",
        "  771 ms     415 µs  external SAVEPOINT __asyncpg_savepoint_2d2__;",
        "  760 ms     379 µs  external SELECT id,",
      ]
    `);
    expect(rows.slice(0, 12)).toMatchInlineSnapshot(`
      [
        "  350 ms      10 µs  call     POST /api/users",
        "  444 ms      23 µs  call     ServerErrorMiddleware",
        "  817 ms     624 µs  call     APIRouter",
        "  247 ms       4 µs  call     _get_db_pool",
        "  679 ms     184 µs  return   _get_db_pool",
        "  509 ms      41 µs  call     _get_connection_from_pool",
        "  501 ms      38 µs  call     FakeAsyncPGPool.acquire",
        "  168 ms       2 µs  call     FakePoolAcquireContent.__init__",
        "  168 ms       2 µs  return   FakePoolAcquireContent.__init__",
        "  495 ms      36 µs  return   FakeAsyncPGPool.acquire",
        "  168 ms       2 µs  call     FakePoolAcquireContent.__aenter__",
        "  717 ms     257 µs  return   FakePoolAcquireContent.__aenter__",
      ]
    `);
    expect(new Set(even)).toEqual(new Set([450]));
  });

  test("durations read naturally at every unit boundary", () => {
    expect([0, 999, 999.6, 9_949, 9_960, 999_499, 999_700, 1_234_567].map(formatMicros)).toEqual([
      "0 µs", "999 µs", "1.0 ms", "9.9 ms", "10 ms", "999 ms", "1.00 s", "1.23 s",
    ]);
  });
});
