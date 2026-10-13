import * as vscode from "vscode";

import { SourceReader, TraceFiles } from "@hexvis/core";

/** TraceFiles over a .hexvis/traces directory, read through VS Code's file system API. */
export function traceFilesAt(tracesDirectory: vscode.Uri): TraceFiles {
  return {
    async readText(relativePath: string): Promise<string> {
      const bytes = await vscode.workspace.fs.readFile(childUri(tracesDirectory, relativePath));
      return new TextDecoder("utf-8").decode(bytes);
    },
  };
}

/** Project source, relative to the project root (the folder holding .hexvis/). */
export function sourceReaderAt(projectRoot: vscode.Uri): SourceReader {
  return {
    async readLines(relativeFile: string): Promise<string[] | null> {
      try {
        const bytes = await vscode.workspace.fs.readFile(childUri(projectRoot, relativeFile));
        return new TextDecoder("utf-8").decode(bytes).split(/\r?\n/);
      } catch {
        return null; // the function view still works without text
      }
    },
  };
}

export function childUri(base: vscode.Uri, relativePath: string): vscode.Uri {
  return vscode.Uri.joinPath(base, ...safeSegments(relativePath));
}

/**
 * Paths come from trace files and the webview, which are data: refuse anything that would
 * climb out of the directory it's meant to be inside.
 */
export function safeSegments(relativePath: string): string[] {
  const segments = relativePath.split(/[\\/]/);
  if (/^([a-zA-Z]:)?[\\/]/.test(relativePath) || segments.some((segment) => segment === "..")) {
    throw new Error(`refusing a path outside the project: ${relativePath}`);
  }
  return segments.filter((segment) => segment !== "" && segment !== ".");
}
