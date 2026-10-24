// Which language model `--explain` and `--describe` ask (ModelChoice): the CLI's choice
// among infra's models, from what this machine has.
import type { LanguageModel, ModelChoice } from "@runshape/kernel";
import { ANTHROPIC_API, AnthropicApiModel, ClaudeCliModel, DEFAULT_API_MODEL } from "@runshape/infra";

/** The model `--explain` and `--describe` ask: `claude -p` if it runs, else the API if a key is set (or the one asked for). */
export async function chooseModel(choice: ModelChoice, env: Record<string, string | undefined>): Promise<LanguageModel> {
  const claude = new ClaudeCliModel(env.RUNSHAPE_CLAUDE ?? "claude");
  const api = env.ANTHROPIC_API_KEY ? new AnthropicApiModel(env.ANTHROPIC_API_KEY, env.RUNSHAPE_MODEL ?? DEFAULT_API_MODEL, env.ANTHROPIC_BASE_URL ?? ANTHROPIC_API) : null;
  if (choice === "api") {
    if (api === null) throw new Error("the API model (=api) needs ANTHROPIC_API_KEY");
    return api;
  }
  if (await claude.runs()) return claude;
  if (choice === "claude") throw new Error("=claude: the claude command doesn't run (install it, or point RUNSHAPE_CLAUDE at it)");
  if (api !== null) return api;
  throw new Error("no language model: install the claude command (or point RUNSHAPE_CLAUDE at it), or set ANTHROPIC_API_KEY");
}
