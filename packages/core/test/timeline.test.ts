/**
 * A scenario as a flame chart: every call as a bar over time, nested under its caller,
 * with the intervals it was actually running — an async handler's bar has gaps while it
 * awaits the database. External calls are marks under the call that made them.
 */
import { describe, expect, test } from "vitest";

import { formatMicros } from "../src/views/replay";
import { buildTimeline } from "../src/views/timeline";
import { loadFixtureRun } from "./fixtures";

describe("timeline", () => {
  test("registering a user over FastAPI: the request, its dependencies, and an async handler that awaits", async () => {
    const run = await loadFixtureRun("fastapi");
    const timeline = buildTimeline(run.scenario("tests/test_api/test_routes/test_registration.py::test_user_success_registration")!);
    const at = (us: number) => formatMicros(us - timeline.startUs);

    const outline = timeline.bars
      .filter((bar) => bar.depth <= 3)
      .slice(0, 14)
      .map((bar) => `${"  ".repeat(bar.depth)}${bar.label.split("\n")[0]}  ${at(bar.startUs)} → ${at(bar.endUs)}${bar.runs.length > 1 ? `  (${bar.runs.length} runs)` : ""}`);
    expect({ span: formatMicros(timeline.endUs - timeline.startUs), bars: timeline.bars.length, externals: timeline.externals.length, depth: timeline.depth }).toMatchInlineSnapshot(`
      {
        "bars": 40,
        "depth": 11,
        "externals": 6,
        "span": "375 ms",
      }
    `);
    expect(outline).toMatchInlineSnapshot(`
      [
        "test_user_success_registration  0 µs → 375 ms  (19 runs)",
        "  POST /api/users  370 µs → 189 ms  (18 runs)",
        "    ServerErrorMiddleware  380 µs → 189 ms  (18 runs)",
        "      CORSMiddleware  385 µs → 189 ms  (18 runs)",
        "  FakeAsyncPGPool.acquire  189 ms → 189 ms",
        "    FakePoolAcquireContent.__init__  189 ms → 189 ms",
        "  FakePoolAcquireContent.__aenter__  189 ms → 189 ms",
        "  BaseRepository.__init__  189 ms → 189 ms",
        "  UsersRepository.get_user_by_email  189 ms → 189 ms  (2 runs)",
        "    BaseRepository.connection  189 ms → 189 ms",
        "    DateTimeModelMixin.default_datetime  189 ms → 189 ms",
        "    DateTimeModelMixin.default_datetime  189 ms → 189 ms",
        "  UserInDB.check_password  190 ms → 375 ms",
        "    verify_password  190 ms → 375 ms",
      ]
    `);
    // No two bars on a row overlap in time, and runs never leave their bar.
    const rows = new Map<number, [number, number][]>();
    for (const bar of timeline.bars) {
      for (const [start, end] of rows.get(bar.depth) ?? []) expect(bar.startUs >= end || bar.endUs <= start, bar.label).toBe(true);
      rows.set(bar.depth, [...(rows.get(bar.depth) ?? []), [bar.startUs, bar.endUs]]);
    }
    for (const bar of timeline.bars) {
      for (const [start, end] of bar.runs) {
        expect(start).toBeGreaterThanOrEqual(bar.startUs);
        expect(end).toBeLessThanOrEqual(bar.endUs);
      }
    }
  });
});
