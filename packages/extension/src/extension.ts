// Composition root: the only module that wires VS Code, the adapters and the core together.
import * as vscode from "vscode";

import { LATEST_POINTER, RULES_FILE } from "@hexvis/core";

import { Logger } from "./logger";
import { RuntimePanel } from "./runtime-panel";

const TRACES_GLOB = `**/.hexvis/traces/${LATEST_POINTER}`;
const EXCLUDE_GLOB = "**/{node_modules,.venv,venv,.git}/**";
const MAX_PROJECTS_SEARCHED = 20;
const RELOAD_DEBOUNCE_MS = 400;

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel("HexVis", { log: true });
  const logger = new Logger(channel);
  const version = String(context.extension.packageJSON.version ?? "unknown");
  logger.info("extension.activated", { version, workspaceFolders: vscode.workspace.workspaceFolders?.length ?? 0 });

  const panels = new Map<string, RuntimePanel>();

  const open = async (): Promise<void> => {
    try {
      const projectRoot = await pickProject(logger);
      if (projectRoot === undefined) return;
      const existing = panels.get(projectRoot.toString());
      if (existing) {
        existing.reveal();
        return;
      }
      const panel = RuntimePanel.open(context.extensionUri, projectRoot, logger, () => panels.delete(projectRoot.toString()));
      panels.set(projectRoot.toString(), panel);
    } catch (error) {
      logger.error("command.open.failed", error);
      void vscode.window.showErrorMessage(`HexVis could not open: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const reloadAll = async (reason: string): Promise<void> => {
    for (const panel of panels.values()) {
      await panel.reload(reason);
    }
  };

  // Re-running the tests rewrites latest.json; follow it so the view tracks the code.
  const watcher = vscode.workspace.createFileSystemWatcher(TRACES_GLOB);
  // One debounce timer per project, so two projects re-recording together both reload.
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const onRecording = (uri: vscode.Uri) => {
    const projectRoot = projectRootOf(uri);
    const key = projectRoot.toString();
    clearTimeout(pending.get(key));
    pending.set(
      key,
      setTimeout(() => {
        pending.delete(key);
        logger.info("recording.changed", { project: projectRoot.fsPath });
        void panels.get(key)?.reload("new recording");
      }, RELOAD_DEBOUNCE_MS),
    );
  };
  watcher.onDidChange(onRecording);
  watcher.onDidCreate(onRecording);

  // hexvis.json sits at the project root, beside .hexvis/.
  const rulesWatcher = vscode.workspace.createFileSystemWatcher(`**/${RULES_FILE}`);
  const onRules = (uri: vscode.Uri) => {
    const projectRoot = vscode.Uri.joinPath(uri, "..");
    logger.info("rules.changed", { project: projectRoot.fsPath });
    void panels.get(projectRoot.toString())?.reloadRules();
  };
  rulesWatcher.onDidChange(onRules);
  rulesWatcher.onDidCreate(onRules);
  rulesWatcher.onDidDelete(onRules);

  context.subscriptions.push(
    channel,
    watcher,
    rulesWatcher,
    { dispose: () => pending.forEach((timer) => clearTimeout(timer)) },
    vscode.commands.registerCommand("hexvis.open", open),
    vscode.commands.registerCommand("hexvis.reload", () => reloadAll("command")),
  );
}

export function deactivate(): void {
  // Disposables registered on the context are cleaned up by VS Code.
}

async function pickProject(logger: Logger): Promise<vscode.Uri | undefined> {
  const pointers = await vscode.workspace.findFiles(TRACES_GLOB, EXCLUDE_GLOB, MAX_PROJECTS_SEARCHED);
  const projects = pointers.map(projectRootOf);
  logger.info("projects.found", { count: projects.length });
  if (projects.length === 0) {
    void vscode.window.showInformationMessage(
      "No HexVis recording in this workspace yet. Install the hexvis-recorder pytest plugin and run your tests with `pytest --hexvis`.",
    );
    return undefined;
  }
  if (projects.length === 1) return projects[0];
  const picked = await vscode.window.showQuickPick(
    projects.map((uri) => ({ label: vscode.workspace.asRelativePath(uri), uri })),
    { placeHolder: "Which project's recording?" },
  );
  return picked?.uri;
}

/** <project>/.hexvis/traces/latest.json -> <project> */
function projectRootOf(latestPointer: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(latestPointer, "..", "..", "..");
}
