/** An object a replay can show, hide, or be popping into view. */
export interface ClockedObject {
  seenUs: number;
  shown: boolean;
  /** When it started popping into view (performance.now()); null once settled. */
  poppedAt: number | null;
}

export const POP_MS = 420;

/**
 * Moves the replay clock: objects not yet seen by `tUs` are hidden; those the clock has just
 * passed start popping. `null` ends the replay: everything shows, without popping.
 */
export function advanceClock(objects: ClockedObject[], tUs: number | null, now: number): void {
  for (const object of objects) {
    const shown = tUs === null || object.seenUs <= tUs;
    object.poppedAt = shown && !object.shown && tUs !== null ? now : shown ? object.poppedAt : null;
    object.shown = shown;
  }
}

/** How far through its pop an object is: its size (overshooting a little) and how far it has risen (0 at the tile, 1 at its slot). */
export function popPose(object: ClockedObject, now: number): { size: number; risen: number; settled: boolean } {
  if (!object.shown) return { size: 0, risen: 0, settled: true };
  if (object.poppedAt === null) return { size: 1, risen: 1, settled: true };
  const progress = Math.min(1, Math.max(0, (now - object.poppedAt) / POP_MS));
  return { size: Math.max(0, easeOutBack(progress)), risen: Math.min(1, progress * 1.4), settled: progress >= 1 };
}

/** 0 → 1 with a small overshoot past 1 before settling. */
function easeOutBack(t: number): number {
  const overshoot = 1.7;
  return 1 + (overshoot + 1) * (t - 1) ** 3 + overshoot * (t - 1) ** 2;
}
