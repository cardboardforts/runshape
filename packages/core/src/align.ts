// Aligning two sequences by key (Myers' diff, as in `git diff`): the shortest edit that turns
// what ran before into what ran after. Used for call sequences, executed statements and
// replay hops alike.

export enum Op {
  Same = "same",
  Added = "added",
  Removed = "removed",
}

export interface Aligned<T> {
  op: Op;
  before: T | null;
  after: T | null;
}

export interface Alignment<T> {
  steps: Aligned<T>[];
  /**
   * False when the sequences differ by more than MAX_EDIT_DISTANCE edits: the steps are then
   * "everything removed, everything added", which is true but says nothing about what
   * stayed — callers must say so rather than present it as a finding.
   */
  complete: boolean;
}

/** Work and memory grow with the square of this (≈36 MB of trace at the limit). */
export const MAX_EDIT_DISTANCE = 3000;

/** One saved row of the search: furthest x per diagonal k, for k in [base, base + values.length). */
interface TraceRow {
  base: number;
  values: Int32Array;
}

export function align<T>(before: T[], after: T[], key: (item: T) => string): Alignment<T> {
  const a = before.map(key);
  const b = after.map(key);
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: TraceRow[] = [];

  for (let d = 0; d <= max; d += 1) {
    // Backtracking at depth d reads diagonals -d-1 … d+1 of the row before this one.
    trace.push({ base: -d - 1, values: v.slice(offset - d - 1, offset + d + 2) });
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!);
      let x = down ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return { steps: backtrack(trace, before, after, n, m), complete: true };
    }
  }
  return {
    steps: [
      ...before.map((item) => ({ op: Op.Removed, before: item, after: null })),
      ...after.map((item) => ({ op: Op.Added, before: null, after: item })),
    ],
    complete: false,
  };
}

function backtrack<T>(trace: TraceRow[], before: T[], after: T[], n: number, m: number): Aligned<T>[] {
  const result: Aligned<T>[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const row = trace[d]!;
    const at = (k: number) => row.values[k - row.base]!;
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const previousK = down ? k + 1 : k - 1;
    const previousX = at(previousK);
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) {
      x -= 1;
      y -= 1;
      result.push({ op: Op.Same, before: before[x]!, after: after[y]! });
    }
    if (d > 0) {
      if (x === previousX) result.push({ op: Op.Added, before: null, after: after[previousY]! });
      else result.push({ op: Op.Removed, before: before[previousX]!, after: null });
    }
    x = previousX;
    y = previousY;
  }
  return result.reverse();
}
