// Runs inside the VS Code extension host.
const assert = require("node:assert");
const vscode = require("vscode");

const WEBVIEW_SETTLE_MS = 6000;
const COMPONENT = "class:conduit.apps.articles.views.ArticleViewSet";

exports.run = async function run() {
  await vscode.commands.executeCommand("runshape.open");
  // The webview loads its bundle, renders, and posts "ready" and "graph"; give it time.
  await new Promise((resolve) => setTimeout(resolve, WEBVIEW_SETTLE_MS));
  const panels = vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter((tab) => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes("runshape.runtime"));
  assert.strictEqual(panels.length, 1, `expected one Runshape panel, found ${panels.length}`);

  // "Suggest a zone" through VS Code's language model API, answered by the fake model
  // extension loaded beside Runshape. With an id the command returns the proposal, no UI.
  const response = await vscode.commands.executeCommand("runshape.suggestZone", COMPONENT);
  assert.deepStrictEqual(response, {
    type: "zoneAdvice",
    componentId: COMPONENT,
    advice: { zone: "core", reason: "Fake model: domain logic with no I/O of its own.", confidence: "medium" },
  });
};
