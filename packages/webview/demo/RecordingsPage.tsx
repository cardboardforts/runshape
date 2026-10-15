import { useEffect, useState } from "react";

import type { LibraryOverview, RecordingMetadata, RefSummary } from "@runshape/library";

interface Props {
  /** The example recordings checked in as fixtures, by name. */
  examples: string[];
  /** Pairs recorded by the old self-review, before recordings were kept per commit. */
  olderPairs: string[];
}

type State = { kind: "loading" } | { kind: "failed"; message: string } | { kind: "ready"; overview: LibraryOverview };

const COMMAND = "npm run runshape --";

/**
 * What there is to look at and to diff: the recordings kept per commit, the branch tips not
 * recorded yet (and the command that records each), and the examples. Read from the dev
 * server on every load, so a recording made a moment ago is already here.
 */
export function RecordingsPage({ examples, olderPairs }: Props) {
  const [state, setState] = useState<State>({ kind: "loading" });

  // The dev server is the outside world: ask it once.
  useEffect(() => {
    let cancelled = false;
    fetch("/__runshape/library")
      .then(async (response) => {
        if (!response.ok) throw new Error((await response.text()) || `the dev server answered ${response.status}`);
        return (await response.json()) as LibraryOverview;
      })
      .then(
        (overview) => !cancelled && setState({ kind: "ready", overview }),
        (error: unknown) => !cancelled && setState({ kind: "failed", message: error instanceof Error ? error.message : String(error) }),
      );
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="recordings-page">
      <h1>Runshape recordings</h1>
      {state.kind === "loading" && <p className="muted">Reading .runshape/recordings…</p>}
      {state.kind === "failed" && (
        <p role="alert">
          Couldn't read the recordings: {state.message}. The list needs the demo's dev server (<code>npm run dev -w packages/webview</code>).
        </p>
      )}
      {state.kind === "ready" && <Library overview={state.overview} />}
      <Examples examples={examples} olderPairs={olderPairs} />
    </main>
  );
}

function Library({ overview }: { overview: LibraryOverview }) {
  const { working, recordings, refs } = overview;
  const unrecorded = refs.filter((ref) => ref.recordingId === null);
  return (
    <>
      <section aria-labelledby="working-heading">
        <h2 id="working-heading">Your working tree</h2>
        <p>
          <strong>{working.branch ?? "detached HEAD"}</strong> at <code>{working.commit.slice(0, 7)}</code>,{" "}
          {working.dirty ? "with uncommitted changes" : "no uncommitted changes"}.
        </p>
        <p>{workingRecordingNote(recordings.find((r) => r.id === "working"), working)}</p>
        <p>
          Compare it with the latest main: <Command text={`${COMMAND} compare main --fetch`} />
        </p>
      </section>

      {recordings.length === 0 ? (
        <section aria-labelledby="recorded-heading">
          <h2 id="recorded-heading">Recorded</h2>
          <p className="muted">Nothing recorded yet. Record a branch below, or the working tree: <Command text={`${COMMAND} record working`} /></p>
        </section>
      ) : (
        <>
          <ComparePicker recordings={recordings} refs={refs} />
          <section aria-labelledby="recorded-heading">
            <h2 id="recorded-heading">Recorded ({recordings.length})</h2>
            <table className="recordings-table">
              <thead>
                <tr>
                  <th scope="col">Recording</th>
                  <th scope="col">Branches at it</th>
                  <th scope="col">Commit</th>
                  <th scope="col">Tests</th>
                  <th scope="col">Recorded</th>
                  <th scope="col">
                    <span className="visually-hidden">Open</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {recordings.map((recording) => (
                  <tr key={recording.id}>
                    <td>
                      <code>{recording.id}</code>
                    </td>
                    <td>{namesFor(recording, refs).join(", ") || <span className="muted">no branch</span>}</td>
                    <td>{recording.subject}</td>
                    <td>
                      {recording.tests.total}
                      {recording.tests.failed > 0 && <span className="failed"> ({recording.tests.failed} failed)</span>}
                    </td>
                    <td title={recording.recordedAt}>{when(recording.recordedAt)}</td>
                    <td>
                      <a href={`?recording=${encodeURIComponent(recording.id)}`}>View</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}

      {unrecorded.length > 0 && (
        <section aria-labelledby="unrecorded-heading">
          <h2 id="unrecorded-heading">Not recorded yet</h2>
          <p className="muted">Branch tips with no recording of their commit. Each is recorded once, then can be compared with anything.</p>
          <ul className="unrecorded">
            {unrecorded.map((ref) => (
              <li key={`${ref.kind}:${ref.name}`}>
                <span className="ref-name">
                  {ref.name}
                  {ref.current && <span className="muted"> (checked out)</span>}
                </span>
                <span className="ref-subject">{ref.subject}</span>
                <Command text={`${COMMAND} record ${ref.kind === "remote" ? `${ref.name} --fetch` : ref.name}`} />
              </li>
            ))}
          </ul>
        </section>
      )}
      {overview.problems.length > 0 && (
        <details>
          <summary>{overview.problems.length} unreadable recording(s)</summary>
          <ul>
            {overview.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

/** Pick a base and a head among the recordings; main and the working tree by default. */
function ComparePicker({ recordings, refs }: { recordings: RecordingMetadata[]; refs: RefSummary[] }) {
  const [base, setBase] = useState(() => defaultBase(recordings, refs));
  // The working tree, else the newest recording that isn't the base.
  const [head, setHead] = useState(() => recordings.find((r) => r.id === "working")?.id ?? recordings.find((r) => r.id !== base)?.id ?? base);
  const option = (recording: RecordingMetadata) => (
    <option key={recording.id} value={recording.id}>
      {[recording.id === "working" ? "working tree" : recording.id.slice(0, 7), ...namesFor(recording, refs).filter((name) => !name.startsWith("working tree"))].join(" · ")} — {recording.subject}
    </option>
  );
  return (
    <section aria-labelledby="compare-heading">
      <h2 id="compare-heading">Compare two recordings</h2>
      {recordings.length < 2 ? (
        <p className="muted">One recording so far: record another to compare with it.</p>
      ) : (
        <form
          className="compare-picker"
          onSubmit={(event) => {
            event.preventDefault();
            location.search = `?base=${encodeURIComponent(base)}&head=${encodeURIComponent(head)}`;
          }}
        >
          <label>
            Before (base)
            <select value={base} onChange={(event) => setBase(event.target.value)}>
              {recordings.map(option)}
            </select>
          </label>
          <label>
            After (head)
            <select value={head} onChange={(event) => setHead(event.target.value)}>
              {recordings.map(option)}
            </select>
          </label>
          <button type="submit" disabled={base === head}>
            Compare
          </button>
          {base === head && <span className="muted">Pick two different recordings.</span>}
        </form>
      )}
    </section>
  );
}

function Examples({ examples, olderPairs }: Props) {
  return (
    <section aria-labelledby="examples-heading">
      <h2 id="examples-heading">Examples</h2>
      <p className="muted">Recordings checked in with Runshape; the ones named after a change have a before and an after to compare.</p>
      <ul className="examples">
        {examples.map((name) => (
          <li key={name}>
            <a href={`?app=${encodeURIComponent(name)}`}>{name}</a>
          </li>
        ))}
      </ul>
      {olderPairs.length > 0 && (
        <details>
          <summary>Older self-review pairs ({olderPairs.length})</summary>
          <ul className="examples">
            {olderPairs.map((label) => (
              <li key={label}>
                <a href={`?app=${encodeURIComponent(`self:${label}`)}`}>{label}</a>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

/** A command to run, with a button that copies it. */
function Command({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="command">
      <code>{text}</code>
      <button
        type="button"
        className="link"
        aria-label={`Copy: ${text}`}
        onClick={() => navigator.clipboard.writeText(text).then(() => setCopied(true), () => setCopied(false))}
      >
        {copied ? "copied" : "copy"}
      </button>
    </span>
  );
}

/** Whether the working tree's recording still shows it: a later commit means it can't. */
function workingRecordingNote(recording: RecordingMetadata | undefined, working: LibraryOverview["working"]): string {
  if (recording === undefined) return "Not recorded yet.";
  const at = `Last recorded ${when(recording.recordedAt)}`;
  if (recording.commit !== working.commit) return `${at}, at ${recording.commit.slice(0, 7)}: before your latest commit, so it's out of date.`;
  return `${at}${working.dirty ? "; changes since then aren't in it" : ""}.`;
}

function namesFor(recording: RecordingMetadata, refs: RefSummary[]): string[] {
  if (recording.id === "working") return [`working tree (${recording.branch ?? "detached"}${recording.dirty ? ", uncommitted changes" : ""})`];
  return refs.filter((ref) => ref.recordingId === recording.id).map((ref) => ref.name);
}

/** The recording of main, else of origin/main, else the oldest. */
function defaultBase(recordings: RecordingMetadata[], refs: RefSummary[]): string {
  for (const name of ["main", "origin/main", "master", "origin/master"]) {
    const id = refs.find((ref) => ref.name === name)?.recordingId;
    if (id) return id;
  }
  return recordings[recordings.length - 1]!.id;
}

/** How long ago, roughly: enough to tell this morning's recording from last week's. */
function when(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(iso).toLocaleDateString();
}
