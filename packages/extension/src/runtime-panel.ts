import * as vscode from "vscode";

import { Phase, ZoneSource, Run, RunSource, TraceDirectory, UiRequest, UiResponse, ViewerSession } from "@runshape/core";

import type { Logger } from "./logger";
import { confirmingRuleStore, languageModelAvailable, readRules, vscodeModelAdvisor } from "./zone-adapters";
import { childUri, sourceReaderAt, traceFilesAt } from "./workspace-files";

const VIEW_TYPE = "runshape.runtime";

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

  get isActive(): boolean {
    return this.panel.active;
  }

  static open(extensionUri: vscode.Uri, projectRoot: vscode.Uri, logger: Logger, onDisposed: () => void): RuntimePanel {
    const webviewRoot = vscode.Uri.joinPath(extensionUri, "dist", "webview");
    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      `Runshape: ${projectRoot.path.split("/").pop() ?? "runtime"}`,
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

  /** runshape.json changed on disk: re-read it and tell the view to redraw. */
  async reloadRules(): Promise<void> {
    if (this.session === null) return;
    try {
      const session = await this.session;
      const { rules, problem } = await readRules(this.projectRoot);
      if (problem !== null) {
        this.logger.warn("rules.invalid", { problem });
        await this.post({ type: "error", message: problem });
      }
      // Our own save already updated the session; the watcher seeing that write is no news.
      const unchanged = problem === null && rules.serialize() === session.currentRules().serialize();
      session.replaceRules(rules, problem);
      if (unchanged) return;
      this.logger.info("rules.reloaded", { count: rules.rules.length, style: rules.profile.style });
      await this.post({ type: "rulesChanged", count: rules.rules.length, style: rules.profile.style });
    } catch (error) {
      // No recording loaded yet (or it failed): the rules apply on the next load anyway.
      this.logger.error("rules.reload_failed", error, { project: this.projectRoot.fsPath });
    }
  }

  /**
   * Ask the language model where a component belongs, from the command palette. With a
   * component id (scripts, tests) it returns the proposal without any UI; without one it
   * offers a pick list, shows the proposal, and on "Accept" goes through the same
   * confirmed save as the view.
   */
  async suggestZone(componentId?: string): Promise<UiResponse | null> {
    const requestId = this.nextRequestId++;
    const session = await this.loadSession(requestId);
    const grouping = { collapseMiddleware: true };
    let target = componentId;
    let qualifiedName: string | null = null;
    if (target === undefined) {
      const graph = await session.handle({ type: "graph", phases: [Phase.Call], grouping });
      const placeable = graph?.type === "graph" ? graph.graph.nodes.filter((n) => n.qualifiedName !== null && n.zoneSource !== ZoneSource.Fixed) : [];
      const picked = await vscode.window.showQuickPick(
        placeable.map((node) => ({ label: node.label, description: `${node.zone} (${node.zoneSource})`, detail: node.qualifiedName ?? "", node })),
        { placeHolder: "Which component should the model place?" },
      );
      if (picked === undefined) return null;
      target = picked.node.id;
      qualifiedName = picked.node.qualifiedName;
    }
    this.logger.info("command.suggest_zone", { request: requestId, component: target });
    const response = await session.handle({ type: "adviseZone", componentId: target, grouping });
    if (response !== null) await this.post(response);
    if (qualifiedName !== null && response?.type === "zoneAdvice") {
      const { advice } = response;
      const accept = await vscode.window.showInformationMessage(
        `Proposed zone: ${advice.zone} (${advice.confidence} confidence). ${advice.reason}`,
        "Accept into runshape.json",
      );
      // The session validates the zone against the rules' style before anything is written.
      if (accept) await this.respond({ type: "setZone", qualifiedName, zone: advice.zone, reason: advice.reason, by: "llm" }, requestId);
    } else if (componentId === undefined && response?.type === "zoneAdviceFailed") {
      void vscode.window.showWarningMessage(response.message);
    }
    return response;
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
    const runs = new TraceDirectory(traceFilesAt(vscode.Uri.joinPath(this.projectRoot, ".runshape", "traces")));
    const run = await runs.latest();
    const baseline = await this.loadBaseline(runs, requestId);
    const { rules, problem } = await readRules(this.projectRoot);
    this.logger.info("run.loaded", {
      request: requestId,
      project: this.projectRoot.fsPath,
      scenarios: run.scenarios.length,
      backend: run.backend,
      framework: run.topology?.framework ?? "none",
      problems: run.problems.length,
      baseline: baseline?.createdAt ?? "none",
      rules: rules.rules.length,
      durationMs: Date.now() - started,
    });
    for (const problem of run.problems) this.logger.warn("run.problem", { request: requestId, problem });
    if (problem !== null) {
      this.logger.warn("rules.invalid", { request: requestId, problem });
      run.problems.push(problem);
    }
    return new ViewerSession(run, {
      sources: sourceReaderAt(this.projectRoot),
      baseline,
      rules,
      rulesProblem: problem,
      ruleStore: confirmingRuleStore(this.projectRoot, this.logger),
      advisor: vscodeModelAdvisor(this.logger, await languageModelAvailable()),
    });
  }

  /** The comparison is optional: a missing or unreadable previous run must not block the view. */
  private async loadBaseline(runs: RunSource, requestId: number): Promise<Run | null> {
    try {
      return await runs.previous();
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
    <title>Runshape</title>
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
