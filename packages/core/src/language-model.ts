// Port: a language model that answers a prompt with text. Adapters: `claude -p` and the
// Anthropic API (packages/infra), and VS Code's Language Model API (packages/extension). The
// kernel knows only that there is one; each module's prompts are its own.

export interface LanguageModel {
  /** What answered, kept with what it said: "claude-cli", "anthropic:claude-sonnet-5-5", "vscode". */
  readonly name: string;
  /** False when there's none to ask (VS Code with no model installed, say). */
  readonly available: boolean;
  complete(prompt: string): Promise<string>;
}

/** Which model to ask: claude -p, the Anthropic API, or "auto" (claude -p if it runs, else the API). */
export type ModelChoice = "auto" | "claude" | "api";
