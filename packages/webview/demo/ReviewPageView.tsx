import { useEffect, useState } from "react";

import type { ReviewPage, ReviewPageCost, ReviewPageCount, ReviewPageFunction, ReviewPageMs, ReviewPageTest, ReviewPageThread, ReviewPageTime } from "@runshape/kernel";

type State = { kind: "loading" } | { kind: "failed"; message: string } | { kind: "missing" } | { kind: "ready"; page: ReviewPage; explained: boolean };

/** How a thread's workflows fare, said of the function(s) they run through. */
const WORKFLOW_WORDS: Record<ReviewPageThread["workflows"][number]["kind"], string> = {
  different: "now run differently",
  new: "newly run through",
  gone: "no longer run through",
  same: "run as before",
};

/**
 * One pull request's review, opened from the morning list (?review=<base>..<head>): what to
 * look at first, the tests grouped by cause, and the threads to follow, each test a link into
 * the compared graph at that test.
 */
export function ReviewPageView({ review }: { review: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const file = (name: string) => reviewFile(review, name);

  // The dev server is the outside world: ask it once per review.
  useEffect(() => {
    const file = (name: string) => reviewFile(review, name);
    let cancelled = false;
    const explained = fetch(file("explanation.md")).then((response) => response.ok, () => false);
    fetch(file("page.json"))
      .then(async (response) => {
        // A review saved before pages were: there's still its Markdown.
        if (response.status === 404) return null;
        if (!response.ok) throw new Error((await response.text()) || `the dev server answered ${response.status}`);
        return (await response.json()) as ReviewPage;
      })
      .then(
        async (page) => !cancelled && setState(page === null ? { kind: "missing" } : { kind: "ready", page, explained: await explained }),
        (error: unknown) => !cancelled && setState({ kind: "failed", message: error instanceof Error ? error.message : String(error) }),
      );
    return () => {
      cancelled = true;
    };
  }, [review]);

  return (
    <main className="recordings-page review-page">
      <p>
        <a href="?">← Recordings</a>
      </p>
      {state.kind === "loading" && <p className="muted">Reading the review…</p>}
      {state.kind === "failed" && <p role="alert">Couldn't read the review: {state.message}. The page needs the demo's dev server (<code>npm run dev -w packages/webview</code>).</p>}
      {state.kind === "missing" && (
        <p>
          This review was saved before PR pages were: <a href={file("review.md")}>read its Markdown</a>, or compare it again to get the page.
        </p>
      )}
      {state.kind === "ready" && <Page page={state.page} explained={state.explained} file={file} />}
    </main>
  );
}

function reviewFile(review: string, name: string): string {
  return `/__runshape/reviews/${encodeURIComponent(review)}/${name}`;
}

function Page({ page, explained, file }: { page: ReviewPage; explained: boolean; file: (name: string) => string }) {
  const compared = `?base=${encodeURIComponent(page.base.recording)}&head=${encodeURIComponent(page.head.recording)}`;
  const into = (test: ReviewPageTest) => `${compared}&scenario=${encodeURIComponent(test.id)}`;
  const quiet = page.callouts.length === 0 && page.sections.length === 0 && page.threads.length === 0;
  return (
    <>
      <h1>{page.head.asked}</h1>
      <p className="muted">
        {page.head.subject} (<code>{page.head.commit.slice(0, 7)}</code>) against {page.base.asked} (<code>{page.base.commit.slice(0, 7)}</code>)
      </p>
      <p className="pr-links">
        <a href={compared}>Compare the graphs</a> · <a href={file("review.md")}>review.md</a>
        {explained && (
          <>
            {" · "}
            <a href={file("explanation.md")}>why it changed (model's account)</a>
          </>
        )}
      </p>
      <p>{page.headline}</p>
      {quiet ? (
        <p>Behaves as before, architecture unchanged.</p>
      ) : (
        <ul className="attention" aria-label="What needs looking at">
          {page.callouts.map((callout) => (
            <li key={callout.text} className={callout.tone === "info" ? undefined : callout.tone}>
              {callout.text}
            </li>
          ))}
        </ul>
      )}
      {page.cost !== undefined && <Cost cost={page.cost} into={into} />}
      {page.threads.length > 0 && (
        <section aria-labelledby="threads-heading">
          <h2 id="threads-heading">Threads to follow ({page.threads.length})</h2>
          {page.threadsBasis === "behaviour" && <p className="muted">These recordings don't keep their source: a function counts as changed when a workflow ran it differently.</p>}
          <ol className="threads">
            {page.threads.map((thread) => (
              <Thread key={thread.functions.map(functionKey).join(" ")} thread={thread} into={into} />
            ))}
          </ol>
        </section>
      )}
      {page.sections.map((section) => (
        <section key={section.heading} aria-label={section.heading}>
          <h2>
            {section.heading} ({section.rows.reduce((total, row) => total + row.tests.length, 0)})
          </h2>
          <ul className="review-rows">
            {section.rows.map((row) => (
              <li key={row.tests[0]!.id}>
                <Tests tests={row.tests} into={into} />
                {row.cause.length > 0 && <p className="muted">through {functionsText(row.cause)}</p>}
                <ul className="changes">
                  {row.changes.map((change) => (
                    <li key={change}>{change}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {page.moved.length > 0 && (
        <section aria-labelledby="moved-heading">
          <h2 id="moved-heading">Moved, not changed ({page.moved.length})</h2>
          <ul>
            {page.moved.map((line) => (
              <li key={line}>
                <code>{line}</code>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

/**
 * What the change costs at run time, caveats first: every time on it is one recording each
 * side. The routes whose external calls changed lead, since they say who waits.
 */
function Cost({ cost, into }: { cost: ReviewPageCost; into: (test: ReviewPageTest) => string }) {
  return (
    <section aria-labelledby="cost-heading">
      <h2 id="cost-heading">Cost</h2>
      {cost.caveats.map((caveat) => (
        <p key={caveat} className="muted">
          {caveat}
        </p>
      ))}
      {cost.routes.length > 0 && (
        <ul aria-label="External calls by route">
          {cost.routes.map((route) => (
            <li key={`${route.label} ${route.text}`}>
              <code>{route.label}</code> {route.text}
              <Tests tests={route.tests} into={into} />
            </li>
          ))}
        </ul>
      )}
      {cost.workflows.length > 0 && (
        <table className="recordings-table cost-table">
          <caption>Workflows whose cost changed</caption>
          <thead>
            <tr>
              <th scope="col">Workflow</th>
              <th scope="col">Time (ms)</th>
              <th scope="col">Calls</th>
              <th scope="col">External calls</th>
            </tr>
          </thead>
          <tbody>
            {cost.workflows.map((workflow) => (
              <tr key={workflow.test.id}>
                <th scope="row">{workflow.test.inHead ? <a href={into(workflow.test)}>{workflow.test.name}</a> : workflow.test.name}</th>
                <td>{timeText(workflow.time)}</td>
                <td>{countText(workflow.calls)}</td>
                <td>{countText(workflow.externalCalls)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {cost.newWorkflows.length > 0 && (
        <div>
          <p>New on this branch, not compared ({cost.newWorkflows.length}):</p>
          <ul className="tests">
            {cost.newWorkflows.map(({ test, externalCalls }) => (
              <li key={test.id}>
                <a href={into(test)}>{test.name}</a> ({externalCalls} external {externalCalls === 1 ? "call" : "calls"})
              </li>
            ))}
          </ul>
        </div>
      )}
      {cost.goneWorkflows.length > 0 && (
        <div>
          <p className="muted">Only on the base, not compared ({cost.goneWorkflows.length}):</p>
          <Tests tests={cost.goneWorkflows} into={into} />
        </div>
      )}
      {cost.unchanged > 0 && (
        <p className="muted">
          {cost.unchanged} {cost.unchanged === 1 ? "workflow on both sides costs" : "workflows on both sides cost"} the same: the same calls and external calls, no time change past the noise bands.
        </p>
      )}
      {cost.functions.length > 0 && (
        <table className="recordings-table cost-table">
          <caption>Changed functions, over every workflow</caption>
          <thead>
            <tr>
              <th scope="col">Function</th>
              <th scope="col">Calls</th>
              <th scope="col">Paths that ran</th>
              <th scope="col">External calls under it</th>
              <th scope="col">Time per call (ms)</th>
              <th scope="col">Its own lines per call (ms)</th>
            </tr>
          </thead>
          <tbody>
            {cost.functions.map((fn) => (
              <tr key={functionKey(fn.function)}>
                <th scope="row">{functionsText([fn.function])}</th>
                <td>{countText(fn.calls)}</td>
                <td>{countText(fn.paths)}</td>
                <td>{countText(fn.externalCalls)}</td>
                <td>{timeText(fn.timePerCall)}</td>
                <td>{msText(fn.selfTimePerCall)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function countText({ before, after }: ReviewPageCount): string {
  return before === after ? `${after}` : `${before ?? "—"} → ${after ?? "—"}`;
}

function msText({ beforeMs, afterMs }: ReviewPageMs): string {
  const ms = (value: number | null) => (value === null ? "—" : value.toFixed(1));
  return `${ms(beforeMs)} → ${ms(afterMs)}`;
}

/** A change is named only past the noise bands; otherwise the numbers say "within noise". */
const VERDICT_WORDS: Record<ReviewPageTime["verdict"], string> = {
  slower: ", slower",
  faster: ", faster",
  "within-noise": ", within noise",
  "not-comparable": ", not comparable",
  "one-side": "",
};

function timeText(time: ReviewPageTime): string {
  return `${msText(time)}${VERDICT_WORDS[time.verdict]}`;
}

function Thread({ thread, into }: { thread: ReviewPageThread; into: (test: ReviewPageTest) => string }) {
  const them = thread.functions.length === 1 ? "it" : "them";
  return (
    <li>
      <p>
        <strong>{functionsText(thread.functions)}</strong>
      </p>
      {thread.workflows.length === 0 && <p className="muted">No recorded workflow runs through {them}.</p>}
      {thread.workflows.map(({ kind, tests }) => (
        <div key={kind} className="thread-workflows">
          <span className={kind === "same" ? "muted" : undefined}>
            {tests.length} {tests.length === 1 ? "workflow" : "workflows"} {WORKFLOW_WORDS[kind]}
            {kind === "new" || kind === "gone" ? ` ${them}` : ""}:
          </span>
          <Tests tests={tests} into={into} />
        </div>
      ))}
      {thread.routes.length > 0 && (
        <p className="muted">
          Routes: {thread.routes.map((route) => `${route.label}${route.on === "head" ? " (new)" : route.on === "base" ? " (gone)" : ""}`).join(", ")}
        </p>
      )}
    </li>
  );
}

/** More than this many tests in one place is a list to open, not to scroll past. */
const SHOWN_TESTS = 6;

/** Each test a link into the compared graph, opened at it, one per line; past the first few, behind "N more". */
function Tests({ tests, into }: { tests: ReviewPageTest[]; into: (test: ReviewPageTest) => string }) {
  // A test only the base has isn't in head's graph: named, not linked.
  const item = (test: ReviewPageTest) => <li key={test.id}>{test.inHead ? <a href={into(test)}>{test.name}</a> : <span title="only on the base">{test.name} (base only)</span>}</li>;
  return (
    <ul className="tests">
      {tests.slice(0, SHOWN_TESTS).map(item)}
      {tests.length > SHOWN_TESTS && (
        <li>
          <details>
            <summary>{tests.length - SHOWN_TESTS} more</summary>
            <ul className="tests">{tests.slice(SHOWN_TESTS).map(item)}</ul>
          </details>
        </li>
      )}
    </ul>
  );
}

/** "a, b (ns), added; c (ns2), edited": a thread's functions, by where they are and what happened to them. */
function functionsText(functions: ReviewPageFunction[]): string {
  const byWhere = new Map<string, ReviewPageFunction[]>();
  for (const fn of functions) {
    const where = `${fn.namespace}|${fn.change}`;
    byWhere.set(where, [...(byWhere.get(where) ?? []), fn]);
  }
  return [...byWhere.values()].map((fns) => `${fns.map((fn) => fn.name).join(", ")} (${fns[0]!.namespace}), ${fns[0]!.change}`).join("; ");
}

function functionKey(fn: ReviewPageFunction): string {
  return `${fn.namespace}.${fn.name}`;
}
