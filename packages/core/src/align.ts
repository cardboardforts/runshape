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

/** Beyond this many differences the alignment gives up and reports "all removed, all added". */
export const MAX_EDIT_DISTANCE = 4000;

export function align<T>(before: T[], after: T[], key: (item: T) => string): Aligned<T>[] {
  const a = before.map(key);
  const b = after.map(key);
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];

  for (let d = 0; d <= max; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!);
      let x = down ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, before, after, offset, n, m);
    }
  }
  return [
    ...before.map((item) => ({ op: Op.Removed, before: item, after: null })),
    ...after.map((item) => ({ op: Op.Added, before: null, after: item })),
  ];
}

function backtrack<T>(trace: Int32Array[], before: T[], after: T[], offset: number, n: number, m: number): Aligned<T>[] {
  const result: Aligned<T>[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const v = trace[d]!;
    const k = x - y;
    const down = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!);
    const previousK = down ? k + 1 : k - 1;
    const previousX = v[offset + previousK]!;
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
