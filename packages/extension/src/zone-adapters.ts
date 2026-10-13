import * as vscode from "vscode";

import { ZoneAdvisor, ZoneRules, ZoneRulesError, ZoneRuleStore, RULES_FILE } from "@hexvis/core";

import type { Logger } from "./logger";

export interface LoadedRules {
  rules: ZoneRules;
  /** Set when hexvis.json exists but can't be used; the view shows it and falls back to inference. */
  problem: string | null;
}

export async function readRules(projectRoot: vscode.Uri): Promise<LoadedRules> {
  let bytes: Uint8Array;
  try {
    bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(projectRoot, RULES_FILE));
  } catch {
    return { rules: ZoneRules.none(), problem: null }; // no file: everything is inferred
  }
  try {
    return { rules: ZoneRules.parse(new TextDecoder("utf-8").decode(bytes)), problem: null };
  } catch (error) {
    const message = error instanceof ZoneRulesError ? error.message : String(error);
    return { rules: ZoneRules.none(), problem: `${message} (showing inferred zones until it is fixed)` };
  }
}

/** Writes hexvis.json only after the person confirms the exact change, in a modal. */
export function confirmingRuleStore(projectRoot: vscode.Uri, logger: Logger): ZoneRuleStore {
  return {
    async save(rules: ZoneRules, change: string): Promise<boolean> {
      const choice = await vscode.window.showInformationMessage(
        `Add this rule to ${RULES_FILE}?`,
        { modal: true, detail: change },
        "Add rule",
      );
      if (choice !== "Add rule") {
        logger.info("rules.declined");
        return false;
      }
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(projectRoot, RULES_FILE), new TextEncoder().encode(rules.serialize()));
      logger.info("rules.saved", { count: rules.rules.length });
      return true;
    },
  };
}

/**
 * A model from VS Code's language model API (e.g. one GitHub Copilot provides). Each call
 * is started by a click, and VS Code asks the person to allow the extension the first time.
 * What is sent: the component's name, its functions, what called it and what it called,
 * and its own source — logged as a size only, never the content.
 */
export function vscodeModelAdvisor(logger: Logger, available: boolean): ZoneAdvisor {
  return {
    available,
    async complete(prompt: string): Promise<string> {
      const [model] = await vscode.lm.selectChatModels();
      if (model === undefined) throw new Error("No language model is available in VS Code.");
      logger.info("advice.requested", { model: model.id, promptChars: prompt.length });
      const started = Date.now();
      const response = await model.sendRequest(
        [vscode.LanguageModelChatMessage.User(prompt)],
        { justification: "HexVis asks a model which architectural zone a component belongs in." },
      );
      let text = "";
      for await (const part of response.text) text += part;
      logger.info("advice.received", { model: model.id, answerChars: text.length, durationMs: Date.now() - started });
      return text;
    },
  };
}

export async function languageModelAvailable(): Promise<boolean> {
  try {
    return (await vscode.lm.selectChatModels()).length > 0;
  } catch {
    return false;
  }
}
