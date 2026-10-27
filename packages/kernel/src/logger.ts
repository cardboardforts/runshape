// Port: where the workflows say what happened, at their boundaries. Sinks fit it by shape: the
// CLI's logfmt file (infra), and later VS Code's output channel or a GitHub Action's log.

/** A field's value: flat, so a log aggregator can query by it. */
export type LogValue = string | number | boolean | null;

export type LogFields = Record<string, LogValue>;

export type LogLevel = "info" | "warn" | "error";

export interface Logger {
  /** One event ("pr.reviewed"), one line, with the fields to find it by. */
  log(level: LogLevel, event: string, fields?: LogFields): void;
  /** The same sink, with these fields on every line after: a run's id, a pull request's number. */
  with(fields: LogFields): Logger;
}
