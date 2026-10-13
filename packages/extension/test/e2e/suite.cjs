// Runs inside the VS Code extension host.
const vscode = require("vscode");

const WEBVIEW_SETTLE_MS = 6000;

exports.run = async function run() {
  await vscode.commands.executeCommand("hexvis.open");
  // The webview loads its bundle, renders, and posts "ready" and "graph"; give it time.
  await new Promise((resolve) => setTimeout(resolve, WEBVIEW_SETTLE_MS));
  const panels = vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter((tab) => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes("hexvis.runtime"));
  if (panels.length !== 1) {
    throw new Error(`expected one HexVis panel, found ${panels.length}`);
  }
};
