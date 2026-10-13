import type * as vscode from "vscode";

type Fields = Record<string, string | number | boolean | null | undefined>;

/**
 * logfmt lines on a VS Code log channel (which adds the timestamp and level): machine-
 * parseable, still readable in the Output panel. Every line names an event; request-scoped
 * lines carry the request id first so one webview request can be followed end to end.
 */
export class Logger {
  constructor(private readonly channel: vscode.LogOutputChannel) {}

  info(event: string, fields: Fields = {}): void {
    this.channel.info(format(event, fields));
  }

  warn(event: string, fields: Fields = {}): void {
    this.channel.warn(format(event, fields));
  }

  error(event: string, error: unknown, fields: Fields = {}): void {
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    // The stack is escaped like any value: error messages can carry trace-file content.
    this.channel.error(`${format(event, fields)} error=${quote(firstLine(detail))} stack=${quote(detail)}`);
  }
}

function format(event: string, fields: Fields): string {
  const parts = [`event=${event}`];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    parts.push(`${key}=${quote(String(value))}`);
  }
  return parts.join(" ");
}

/** Quotes values with spaces, and neutralizes newlines so a value can't forge a log line. */
function quote(value: string): string {
  const escaped = value.replace(/\\/g, "\\\\").replace(/\r\n|\r|\n/g, "\\n").replace(/"/g, '\\"');
  return /[\s="]/.test(value) ? `"${escaped}"` : escaped;
}

function firstLine(text: string): string {
  return text.split(/\r\n|\r|\n/, 1)[0] ?? text;
}
