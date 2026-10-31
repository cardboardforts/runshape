import * as vscode from "vscode";

import { TraceFiles } from "@runshape/kernel";
import { ArrangementStore, SourceReader } from "@runshape/workflows";
import { safeSegments } from "@runshape/infra";

/** TraceFiles over a .runshape/traces directory, read through VS Code's file system API. */
export function traceFilesAt(tracesDirectory: vscode.Uri): TraceFiles {
  return {
    async readText(relativePath: string): Promise<string> {
      const bytes = await vscode.workspace.fs.readFile(childUri(tracesDirectory, relativePath));
      return new TextDecoder("utf-8").decode(bytes);
    },
  };
}

/** Project source, relative to the project root (the folder holding .runshape/). */
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

/**
 * The boxes a person moved, in .runshape/arrangement.json (the visualizer's format, as text),
 * through VS Code's file system API like everything else the panel reads. Written beside it,
 * then renamed over it, so a crash never leaves half a file.
 */
export function arrangementFileAt(projectRoot: vscode.Uri): ArrangementStore {
  const file = childUri(projectRoot, ".runshape/arrangement.json");
  const writing = childUri(projectRoot, ".runshape/arrangement.json.writing");
  return {
    where: ".runshape/arrangement.json",
    async read(): Promise<string | null> {
      try {
        return new TextDecoder("utf-8").decode(await vscode.workspace.fs.readFile(file));
      } catch (error) {
        // None yet; anything else is the session's to report, not to save over.
        if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") return null;
        throw error;
      }
    },
    async write(text: string): Promise<void> {
      await vscode.workspace.fs.writeFile(writing, new TextEncoder().encode(text));
      await vscode.workspace.fs.rename(writing, file, { overwrite: true });
    },
  };
}

export function childUri(base: vscode.Uri, relativePath: string): vscode.Uri {
  return vscode.Uri.joinPath(base, ...safeSegments(relativePath));
}
