// Port: a language model that answers a prompt with text. Adapters: `claude -p` and the
// Anthropic API (packages/cli), and VS Code's Language Model API (packages/extension).
import type { ZoneAdvisor } from "./zone-advice";

export interface LanguageModel extends ZoneAdvisor {
  /** What answered, kept with what it said: "claude-cli", "anthropic:claude-sonnet-5-5", "vscode". */
  readonly name: string;
}
