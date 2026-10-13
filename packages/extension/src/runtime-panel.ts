import * as vscode from "vscode";

import { loadLatestRun, loadPreviousRun, Run, UiRequest, UiResponse, ViewerSession } from "@hexvis/core";

import type { Logger } from "./logger";
import { childUri, sourceReaderAt, traceFilesAt } from "./workspace-files";

const VIEW_TYPE = "hexvis.runtime";

/**
 * One webview showing one project's latest recording. Owns the ViewerSession and routes
 * webview messages to it; handles the requests only a host can (open a file, reload).
 */
export class RuntimePanel {
  // A promise, not a session: the webview's first requests arrive together and must share
  // one load rather than each reading the whole recording.
  private session: Promise<ViewerSession> | null = null;
  private nextRequestId = 1;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly projectRoot: vscode.Uri,
    private readonly logger: Logger,
    private readonly onDisposed: () => void,
  ) {
    panel.onDidDispose(() => {
      logger.info("panel.closed", { project: projectRoot.fsPath });
      onDisposed();
    });
    panel.webview.onDidReceiveMessage((message: UiRequest) => this.receive(message));
  }

  static open(extensionUri: vscode.Uri, projectRoot: vscode.Uri, logger: Logger, onDisposed: () => void): RuntimePanel {
    const webviewRoot = vscode.Uri.joinPath(extensionUri, "dist", "webview");
    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      `HexVis: ${projectRoot.path.split("/").pop() ?? "runtime"}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [webviewRoot] },
    );
    panel.webview.html = renderHtml(panel.webview, webviewRoot);
    logger.info("panel.opened", { project: projectRoot.fsPath });
    return new RuntimePanel(panel, projectRoot, logger, onDisposed);
  }

  get project(): vscode.Uri {
    return this.projectRoot;
  }

  reveal(): void {
    this.panel.reveal();
  }

  /** Drops the loaded run; the next request loads the latest recording again. */
  async reload(reason: string): Promise<void> {
    this.logger.info("run.reload", { project: this.projectRoot.fsPath, reason });
    this.session = null;
    await this.post({ type: "loading", message: "Loading the latest recording…" });
    await this.respond({ type: "ready" }, this.nextRequestId++);
  }

  private async receive(request: UiRequest): Promise<void> {
    const requestId = this.nextRequestId++;
    if (request.type === "reload") {
      await this.reload("requested by view");
      return;
    }
    await this.respond(request, requestId);
  }

  private async respond(request: UiRequest, requestId: number): Promise<void> {
    const started = Date.now();
    this.logger.info("webview.request", { request: requestId, type: request.type });
    try {
      if (request.type === "openSource") {
        await this.openSource(request.file, request.line);
      } else {
        const session = await this.loadSession(requestId);
        const response = await session.handle(request);
        if (response !== null) await this.post(response);
      }
      this.logger.info("webview.response", { request: requestId, type: request.type, durationMs: Date.now() - started });
    } catch (error) {
      // Every failure reaches the log with its stack and reaches the view as a message:
      // never a silently blank panel.
      this.logger.error("webview.failed", error, { request: requestId, type: request.type, durationMs: Date.now() - started });
      await this.post({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  private loadSession(requestId: number): Promise<ViewerSession> {
    if (this.session === null) {
      const loading = this.load(requestId);
      this.session = loading;
      // A failed load must not stick: the next request (or Reload) tries again. Only clear
      // it if a reload hasn't already replaced it with a newer load.
      loading.catch(() => {
        if (this.session === loading) this.session = null;
      });
    }
    return this.session;
  }

  private async load(requestId: number): Promise<ViewerSession> {
    const started = Date.now();
    const traces = traceFilesAt(vscode.Uri.joinPath(this.projectRoot, ".hexvis", "traces"));
    const run = await loadLatestRun(traces);
    const baseline = await this.loadBaseline(traces, requestId);
    this.logger.info("run.loaded", {
      request: requestId,
      project: this.projectRoot.fsPath,
      scenarios: run.scenarios.length,
      backend: run.backend,
      framework: run.topology?.framework ?? "none",
      problems: run.problems.length,
      baseline: baseline?.createdAt ?? "none",
      durationMs: Date.now() - started,
    });
    for (const problem of run.problems) this.logger.warn("run.problem", { request: requestId, problem });
    return new ViewerSession(run, sourceReaderAt(this.projectRoot), baseline);
  }

  /** The comparison is optional: a missing or unreadable previous run must not block the view. */
  private async loadBaseline(traces: Parameters<typeof loadPreviousRun>[0], requestId: number): Promise<Run | null> {
    try {
      return await loadPreviousRun(traces);
    } catch (error) {
      this.logger.error("baseline.unreadable", error, { request: requestId, project: this.projectRoot.fsPath });
      return null;
    }
  }

  private async openSource(file: string, line: number): Promise<void> {
    if (!Number.isInteger(line) || line < 1) throw new Error(`not a line number: ${String(line)}`);
    const uri = childUri(this.projectRoot, file);
    const position = new vscode.Position(Math.max(line - 1, 0), 0);
    await vscode.window.showTextDocument(uri, {
      viewColumn: vscode.ViewColumn.Beside,
      selection: new vscode.Range(position, position),
      preserveFocus: false,
    });
  }

  private async post(response: UiResponse): Promise<void> {
    await this.panel.webview.postMessage(response);
  }
}

function renderHtml(webview: vscode.Webview, webviewRoot: vscode.Uri): string {
  const nonce = createNonce();
  const script = webview.asWebviewUri(vscode.Uri.joinPath(webviewRoot, "main.js"));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(webviewRoot, "main.css"));
  // 'unsafe-inline' for styles only: React Flow positions nodes with inline style attributes.
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${style}" />
    <title>HexVis</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" nonce="${nonce}" src="${script}"></script>
  </body>
</html>`;
}

function createNonce(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
