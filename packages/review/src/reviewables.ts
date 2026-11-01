import type { CommentFunction, CommentTarget, ReviewPage, ReviewPageFunction, ReviewPageTest, ReviewPageThread } from "@runshape/kernel";

export enum ReviewableKind {
  /** Changed functions with the same workflows through them: the region a reviewer follows. */
  Thread = "thread",
  Function = "function",
  /** A test that now runs differently, fails, passes, is new or is gone. */
  Test = "test",
}

/** A workflow through changed code, by how it fares: what a reviewer can follow from a function. */
export interface Beam {
  kind: ReviewPageThread["workflows"][number]["kind"];
  tests: ReviewPageTest[];
}

/** Something in a review to check off and comment on. */
export interface Reviewable {
  /**
   * Stable across pushes: "thread:<first function>+<digest of all of them>", "function:<namespace>.<name>"
   * ("#2" after a second function of the same name: an overload), "test:<id>".
   */
  key: string;
  kind: ReviewableKind;
  label: string;
  /** What the review shows of it; when a new comparison shows something else, a check on it no longer holds. */
  fingerprint: string;
  target: CommentTarget;
  /** For a thread or a function: the tests through it. */
  beams: Beam[];
}

/** The comment target for the change as a whole: not checked off, approved. */
export const WHOLE_CHANGE = "change";

/**
 * What a review page has to check off, in the order to read it: each thread and the functions
 * in it, then each test whose behaviour changed (the page's sections, worst first).
 */
export function reviewables(page: ReviewPage): Reviewable[] {
  const items: Reviewable[] = [];
  const functionKey = overloadSafeKeys();
  for (const thread of page.threads) {
    const [first] = thread.functions;
    if (first === undefined) continue;
    const beams = thread.workflows.map((workflow) => ({ kind: workflow.kind, tests: workflow.tests }));
    const seen = { workflows: thread.workflows.map((workflow) => [workflow.kind, workflow.tests.map((test) => test.id)]), routes: thread.routes };
    items.push({
      // Every function names the thread: one gained or lost is another thread to look at.
      key: `${ReviewableKind.Thread}:${qualified(first)}+${fingerprint(thread.functions.map(qualified))}`,
      kind: ReviewableKind.Thread,
      label: `through ${listed(thread.functions.map(qualified))}`,
      fingerprint: fingerprint({ functions: thread.functions, ...seen }),
      target: { kind: "thread", functions: thread.functions.map(commentFunction) },
      beams,
    });
    for (const fn of thread.functions) {
      items.push({
        key: `${ReviewableKind.Function}:${functionKey(qualified(fn))}`,
        kind: ReviewableKind.Function,
        label: `${qualified(fn)} (${fn.change})`,
        // Its revision: edited again since it was checked, it's to look at again.
        fingerprint: fingerprint({ change: fn.change, revision: fn.revision ?? null, ...seen }),
        target: { kind: "function", function: commentFunction(fn) },
        beams,
      });
    }
  }
  const tests = new Set<string>();
  for (const section of page.sections) {
    for (const row of section.rows) {
      for (const test of row.tests) {
        if (tests.has(test.id)) continue;
        tests.add(test.id);
        items.push({
          key: `${ReviewableKind.Test}:${test.id}`,
          kind: ReviewableKind.Test,
          label: `${test.name} (${section.heading.toLowerCase()})`,
          // The heading is its status (now failing, still passing but different, …), and the
          // changes say an outcome that changed ("passed → failed").
          fingerprint: fingerprint({ heading: section.heading, changes: row.changes, cause: row.cause }),
          target: { kind: "test", id: test.id, name: test.name },
          beams: [],
        });
      }
    }
  }
  return items;
}

/**
 * The reviewable a person named: its number in the list `reviewables` gives (from 1), or its
 * key. Null when there's none.
 */
export function findReviewable(items: Reviewable[], named: string): Reviewable | null {
  if (/^[1-9]\d*$/.test(named)) return items[Number(named) - 1] ?? null;
  return items.find((item) => item.key === named) ?? null;
}

/** A thread a refactor sends every test through can hold dozens of functions: its functions are listed below it. */
const FUNCTIONS_IN_THREAD_LABEL = 3;

function listed(names: string[]): string {
  const more = names.length - FUNCTIONS_IN_THREAD_LABEL;
  return more > 0 ? `${names.slice(0, FUNCTIONS_IN_THREAD_LABEL).join(", ")} and ${more} more` : names.join(", ");
}

/** Function names as keys, the second of a name (an overload) with "#2", in the page's order. */
function overloadSafeKeys(): (name: string) => string {
  const seen = new Map<string, number>();
  return (name) => {
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    return count === 1 ? name : `${name}#${count}`;
  };
}

function qualified(fn: ReviewPageFunction): string {
  return `${fn.namespace}.${fn.name}`;
}

function commentFunction(fn: ReviewPageFunction): CommentFunction {
  return { name: fn.name, namespace: fn.namespace };
}

/**
 * A short digest of what the review shows (cyrb53: 53 bits, no crypto: the module runs
 * anywhere). A collision only leaves something checked that should have been un-checked.
 */
function fingerprint(shown: unknown): string {
  const text = JSON.stringify(shown);
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}
