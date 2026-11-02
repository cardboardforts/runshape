/**
 * When a span was running. A recording holds millions of spans and nearly all ran in one
 * interval from their start, so a span keeps that interval without an array and makes the list
 * only when `runs` is read; a coroutine that was suspended and resumed keeps its slices apart.
 * The parser drives a span through stoppedAt (returned, raised or suspended) and resumedAt.
 *
 * The lists are getters on the prototype: compare what they return, never the span itself
 * (toEqual and JSON.stringify don't see them).
 */
import { describe, expect, test } from "vitest";

import { CodeSymbol, FunctionInfo, Phase, Role, Span, SymbolKind } from "../src";

const STARTED_US = 100;

function startedSpan(): Span {
  const fn: FunctionInfo = { role: Role.Source, symbol: new CodeSymbol(["app"], [], "handle", SymbolKind.Function, null), file: "app.py", firstLine: 1, landmarkKind: null };
  return new Span(1, fn, null, null, Phase.Call, STARTED_US, 1);
}

const timing = (span: Span) => ({ runs: span.runs, resumes: span.resumes, endUs: span.endUs });

describe("a span's running intervals", () => {
  test("a plain call, a coroutine suspended and resumed, and a call that never stopped", () => {
    const plain = startedSpan();
    plain.stoppedAt(150);

    const coroutine = startedSpan();
    coroutine.stoppedAt(120); // suspended at an await
    coroutine.resumedAt(200);
    coroutine.stoppedAt(260); // returned

    // Cut off by the end of the recording (or a crash): it ran, but no stop was written.
    const neverStopped = startedSpan();

    expect({ plain: timing(plain), coroutine: timing(coroutine), neverStopped: timing(neverStopped) }).toEqual({
      plain: { runs: [[STARTED_US, 150]], resumes: 0, endUs: 150 },
      coroutine: { runs: [[STARTED_US, 120], [200, 260]], resumes: 1, endUs: 260 },
      // No interval rather than a guess: the timeline draws it from its start to its end.
      neverStopped: { runs: [], resumes: 0, endUs: STARTED_US },
    });
  });
});
