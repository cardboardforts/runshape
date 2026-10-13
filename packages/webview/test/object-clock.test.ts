/**
 * The replay clock for objects in 3D: during a replay an object exists only from the moment
 * the recording first saw it, and pops up out of its class's tile when the clock passes that
 * moment. Seeking back hides it again; closing the replay shows everything, quietly.
 */
import { describe, expect, test } from "vitest";

import { advanceClock, ClockedObject, POP_MS, popPose } from "../src/three/object-clock";

const objects = (): ClockedObject[] => [10, 200, 900].map((seenUs) => ({ seenUs, shown: true, poppedAt: null }));
const state = (all: ClockedObject[]) => all.map((o) => (!o.shown ? "hidden" : o.poppedAt === null ? "shown" : `popping since ${o.poppedAt}`));

describe("object clock", () => {
  test("a replay hides what isn't built yet, pops what the clock passes, and hides it again on seeking back", () => {
    const all = objects();

    advanceClock(all, 50, 1000); // replay starts: what exists already just stays
    const atStart = state(all);
    advanceClock(all, 300, 2000); // the clock passes the second object
    const passed = state(all);
    advanceClock(all, 100, 3000); // seek back before it
    const rewound = state(all);
    advanceClock(all, 1000, 4000);
    advanceClock(all, null, 5000); // replay closed
    const closed = state(all);

    expect({ atStart, passed, rewound, closed }).toEqual({
      atStart: ["shown", "hidden", "hidden"],
      passed: ["shown", "popping since 2000", "hidden"],
      rewound: ["shown", "hidden", "hidden"],
      // The last two popped at 4000 and are mid-pop when the replay closes; nothing new pops.
      closed: ["shown", "popping since 4000", "popping since 4000"],
    });
  });

  test("a pop rises from the tile and overshoots before settling at full size", () => {
    const popping: ClockedObject = { seenUs: 0, shown: true, poppedAt: 0 };
    const at = (ms: number) => popPose(popping, ms);
    const poses = [0, POP_MS * 0.4, POP_MS * 0.75, POP_MS].map((ms) => {
      const { size, risen, settled } = at(ms);
      return `${size.toFixed(2)} ${risen.toFixed(2)} ${settled}`;
    });

    expect(poses).toEqual(["0.00 0.00 false", "1.03 0.56 false", "1.06 1.00 false", "1.00 1.00 true"]);
    expect(popPose({ seenUs: 0, shown: false, poppedAt: null }, 0).size).toBe(0);
  });
});
