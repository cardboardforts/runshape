/**
 * The extension's two trust-boundary controls. Trace files and webview messages are data
 * that could have been written by anyone who can commit to the repo being viewed.
 */
import { describe, expect, test, vi } from "vitest";

vi.mock("vscode", () => ({ Uri: {}, workspace: {} }));

import { Logger } from "../../src/logger";
import { safeSegments } from "../../src/workspace-files";

describe("safeSegments (path traversal)", () => {
  test("keeps project-relative paths, refuses anything that escapes the project", () => {
    expect(safeSegments("app/api/routes/users.py")).toEqual(["app", "api", "routes", "users.py"]);
    expect(safeSegments("./app//main.py")).toEqual(["app", "main.py"]);

    for (const escaping of ["../secrets.env", "app/../../etc/passwd", "/etc/passwd", "C:\\Windows\\win.ini", "app\\..\\..\\x"]) {
      expect(() => safeSegments(escaping), escaping).toThrowError(/refusing a path outside the project/);
    }
  });
});

describe("Logger (log injection)", () => {
  test("a value with a newline cannot start a forged log line", () => {
    const lines: string[] = [];
    const channel = { info: (line: string) => lines.push(line), warn: vi.fn(), error: vi.fn() };
    const logger = new Logger(channel as never);

    logger.info("run.problem", { problem: 'bad file\nevent=extension.activated version="evil"', count: 2 });

    expect(lines).toEqual([
      'event=run.problem problem="bad file\\nevent=extension.activated version=\\"evil\\"" count=2',
    ]);
  });

  test("errors stay on one line too: the stack is a quoted field, not raw text", () => {
    const lines: string[] = [];
    const channel = { info: vi.fn(), warn: vi.fn(), error: (line: string) => lines.push(line) };
    const logger = new Logger(channel as never);

    logger.error("webview.failed", new Error("bad\revent=forged"), { request: 3 });

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(/[\r\n]/);
    expect(lines[0]).toMatch(/^event=webview.failed request=3 error="Error: bad" stack="Error: bad\\nevent=forged\\n/);
  });
});
