// How long each replay hop plays, and recorded times as the viewer writes them: the viewer's
// own presentation, so it lives here, not in the kernel (which holds types and ports only).
import type { ReplayStep } from "@runshape/kernel";

export enum ReplayPace {
  /** Every hop the same length: easiest to follow the path. */
  Even = "even",
  /** Each hop as long as the recording spent before the next one, log-compressed. */
  Recorded = "recorded",
}

export const EVEN_STEP_MS = 450;

const FASTEST_STEP_MS = 90;

/** Each tenfold of recorded time adds this much playback: 1 µs → 90 ms, 1 ms → 870 ms, 100 ms → 1.4 s. */
const MS_PER_DECADE = 260;

const SLOWEST_STEP_MS = 2500;

/** The time the app spent after step `index` before the next hop; the last step has none. */
export function gapAfterUs(steps: ReplayStep[], index: number): number | null {
  const next = steps[index + 1];
  const step = steps[index];
  return next && step ? Math.max(0, next.tUs - step.tUs) : null;
}

export function stepDurationsMs(steps: ReplayStep[], pace: ReplayPace): number[] {
  return steps.map((_, index) => {
    if (pace === ReplayPace.Even) return EVEN_STEP_MS;
    const gap = gapAfterUs(steps, index);
    if (gap === null) return EVEN_STEP_MS;
    const ms = FASTEST_STEP_MS + MS_PER_DECADE * Math.log10(Math.max(gap, 1));
    return Math.round(Math.min(SLOWEST_STEP_MS, ms));
  });
}

/** "742 µs", "3.1 ms", "1.20 s": the recorded gap after a step, for the replay bar. */
export function describeGap(steps: ReplayStep[], index: number): string {
  const gap = gapAfterUs(steps, index);
  return gap === null ? "end" : formatMicros(gap);
}

/** "742 µs", "3.1 ms", "12 ms", "1.20 s". */
export function formatMicros(us: number): string {
  // Thresholds where the rounded value would print as the next unit: 999.6 µs is "1.0 ms".
  if (us < 999.5) return `${Math.round(us)} µs`;
  if (us < 999_500) return `${(us / 1000).toFixed(us < 9_950 ? 1 : 0)} ms`;
  return `${(us / 1_000_000).toFixed(2)} s`;
}
