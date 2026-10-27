/** A field's value; the kernel's Logger port takes the same. */
type LogValue = string | number | boolean | null;
type LogFields = Record<string, LogValue>;

/**
 * Log lines as logfmt (`ts=… level=info run=… event=pr.reviewed pr=7 duration_ms=812`): one
 * line per event, the context fields first, so a run's lines can be grepped or queried by id.
 * Fits the kernel's Logger port by shape.
 */
export class LogfmtLogger {
  constructor(
    private readonly write: (line: string) => void,
    private readonly now: () => Date,
    private readonly context: LogFields = {},
  ) {}

  log(level: "info" | "warn" | "error", event: string, fields: LogFields = {}): void {
    const pairs = Object.entries({ ts: this.now().toISOString(), level, ...this.context, event, ...fields });
    this.write(pairs.map(([key, value]) => `${key}=${logfmtValue(value)}`).join(" "));
  }

  with(fields: LogFields): LogfmtLogger {
    return new LogfmtLogger(this.write, this.now, { ...this.context, ...fields });
  }
}

/**
 * Bare when it can be, else quoted. A newline is escaped, never written: an error message
 * (or a stack) can't start a line of its own that reads as another event.
 */
function logfmtValue(value: LogValue): string {
  if (value === null) return "";
  const text = String(value);
  if (text !== "" && /^[^\s"=\\]+$/.test(text)) return text;
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`;
}
