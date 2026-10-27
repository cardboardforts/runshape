/** A field's value; the kernel's Logger port takes the same. */
type LogValue = string | number | boolean | null;
type LogFields = Record<string, LogValue>;

/**
 * Log lines as logfmt (`ts=… level=info run=… event=pr.reviewed pr=7 duration_ms=812`): one
 * line per event, the context fields first, so a run's lines can be grepped or queried by id.
 * Fits the kernel's Logger port by shape.
 *
 * Logging never stops the work it describes: a write that fails (a full disk, a folder that
 * can't be made) is reported once through `writeFailed`, and the rest are dropped.
 */
export class LogfmtLogger {
  constructor(
    private readonly write: (line: string) => void,
    private readonly now: () => Date,
    private readonly context: LogFields = {},
    private readonly writeFailed: (error: unknown) => void = () => {},
    private readonly state = { failed: false },
  ) {}

  log(level: "info" | "warn" | "error", event: string, fields: LogFields = {}): void {
    if (this.state.failed) return;
    const pairs = new Map<string, LogValue>([["ts", this.now().toISOString()], ["level", level]]);
    for (const [key, value] of Object.entries(this.context)) pairs.set(logfmtKey(key), value);
    pairs.set("event", event);
    // A field can't pass itself off as the run's id or the event: it keeps its value under another name.
    for (const [key, value] of Object.entries(fields)) pairs.set(pairs.has(logfmtKey(key)) ? `field.${logfmtKey(key)}` : logfmtKey(key), value);
    try {
      this.write([...pairs].map(([key, value]) => `${key}=${logfmtValue(value)}`).join(" "));
    } catch (error) {
      this.state.failed = true;
      this.writeFailed(error);
    }
  }

  with(fields: LogFields): LogfmtLogger {
    return new LogfmtLogger(this.write, this.now, { ...this.context, ...fields }, this.writeFailed, this.state);
  }
}

function logfmtKey(key: string): string {
  return key.replace(/[^A-Za-z0-9_.-]/g, "_") || "_";
}

/**
 * Bare when it can be, else quoted. Control characters are escaped, never written: an error
 * message (or a stack, or a PR's title) can't start a line that reads as another event, or
 * send a terminal escape to whoever runs `tail` on the log. Credentials are cut first.
 */
function logfmtValue(value: LogValue): string {
  if (value === null) return "";
  const text = redacted(String(value));
  if (/^[\x21\x23-\x3c\x3e-\x5b\x5d-\x7e -‧‪-￿]+$/.test(text)) return text;
  const escaped = text.replace(/[\\"\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, (char) => CONTROL_ESCAPES[char] ?? `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return `"${escaped}"`;
}

const CONTROL_ESCAPES: Record<string, string> = { "\\": "\\\\", '"': '\\"', "\n": "\\n", "\r": "\\r", "\t": "\\t" };

/**
 * What logs shouldn't carry, wherever it turns up (git echoes a remote's URL in its errors): the
 * user and password in a URL, and tokens shaped like Anthropic's, OpenAI's and GitHub's keys.
 */
function redacted(text: string): string {
  return text
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, "$1[redacted]@")
    .replace(/\b(sk-ant-|sk-|gh[pousr]_|github_pat_)[A-Za-z0-9_-]{8,}/g, "$1[redacted]");
}
