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
  const where = ".runshape/arrangement.json";
  return {
    where,
    async read(): Promise<string | null> {
      let stat: vscode.FileStat;
      try {
        stat = await vscode.workspace.fs.stat(file);
      } catch (error) {
        // None yet; anything else is the session's to report, not to save over.
        if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") return null;
        throw error;
      }
      // A link or a folder isn't followed (whoever put it there chose where it points); nor is a huge file read.
      if (stat.type !== vscode.FileType.File) throw new Error(`${where} isn't a plain file (a link or a folder): not read`);
      if (stat.size > MAX_ARRANGEMENT_BYTES) throw new Error(`${where} is over ${MAX_ARRANGEMENT_BYTES} bytes: not read`);
      return new TextDecoder("utf-8").decode(await vscode.workspace.fs.readFile(file));
    },
    async write(text: string): Promise<void> {
      // A link planted at the side path is removed (the link, not what it points at), never written through.
      await vscode.workspace.fs.delete(writing, { useTrash: false }).then(undefined, () => undefined);
      await vscode.workspace.fs.writeFile(writing, new TextEncoder().encode(text));
      await vscode.workspace.fs.rename(writing, file, { overwrite: true });
    },
  };
}

/** Far past any real arrangement (a few levels of tens of boxes is a few kilobytes): more is refused unread. */
const MAX_ARRANGEMENT_BYTES = 1024 * 1024;

export function childUri(base: vscode.Uri, relativePath: string): vscode.Uri {
  return vscode.Uri.joinPath(base, ...safeSegments(relativePath));
}
