// Dotted-name globs as runshape.json writes them: the zone rules and the taxonomy share them.
import { splitDotted } from "@runshape/kernel";

/**
 * Matches dotted names against a glob, segment by segment: "**" is any number of segments
 * (none too), "*" any text within one segment. Not a regular expression: a run of "**"
 * made one backtrack exponentially, and the globs come from a file in the repository. The
 * memo bounds the work to pattern segments × name segments.
 */
export class Glob {
  private readonly segments: string[];

  constructor(pattern: string) {
    this.segments = splitDotted(pattern);
  }

  matches(parts: readonly string[]): boolean {
    const memo = new Map<number, boolean>();
    const from = (p: number, n: number): boolean => {
      const key = p * (parts.length + 1) + n;
      const known = memo.get(key);
      if (known !== undefined) return known;
      let result: boolean;
      if (p === this.segments.length) {
        result = n === parts.length;
      } else if (this.segments[p] === "**") {
        // Zero segments, or one more and stay on "**".
        result = from(p + 1, n) || (n < parts.length && from(p, n + 1));
      } else {
        result = n < parts.length && segmentMatches(this.segments[p]!, parts[n]!) && from(p + 1, n + 1);
      }
      memo.set(key, result);
      return result;
    };
    return from(0, 0);
  }
}

/** "*" is any text (a "**" inside a segment counts as "*"); greedy with one backtrack point, so linear. */
export function segmentMatches(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let resume = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] !== "*" && pattern[p] === text[t]) {
      p += 1;
      t += 1;
    } else if (p < pattern.length && pattern[p] === "*") {
      star = p;
      resume = t;
      p += 1;
    } else if (star !== -1) {
      p = star + 1;
      resume += 1;
      t = resume;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === "*") p += 1;
  return p === pattern.length;
}
