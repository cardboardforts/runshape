// A language model for the end-to-end test only. It answers every request with the same
// zone proposal and appends each prompt it was sent to HEXVIS_FAKE_MODEL_LOG, so the test
// can check what HexVis actually sent through VS Code's language model API.
const fs = require("node:fs");
const vscode = require("vscode");

const ANSWER = JSON.stringify({ zone: "core", reason: "Fake model: domain logic with no I/O of its own.", confidence: "medium" });

exports.activate = function activate(context) {
  const model = {
    id: "hexvis-fake-1",
    name: "HexVis fake model",
    family: "hexvis-fake",
    version: "1",
    maxInputTokens: 100000,
    maxOutputTokens: 1000,
    capabilities: {},
  };
  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider("hexvis-fake", {
      provideLanguageModelChatInformation: () => [model],
      async provideLanguageModelChatResponse(_model, messages, _options, progress) {
        const prompt = messages
          .map((message) => message.content.map((part) => (part instanceof vscode.LanguageModelTextPart ? part.value : "")).join(""))
          .join("\n");
        if (process.env.HEXVIS_FAKE_MODEL_LOG) fs.appendFileSync(process.env.HEXVIS_FAKE_MODEL_LOG, `${JSON.stringify(prompt)}\n`);
        progress.report(new vscode.LanguageModelTextPart(ANSWER));
      },
      provideTokenCount: async (_model, text) => Math.ceil((typeof text === "string" ? text.length : 1000) / 4),
    }),
  );
};
