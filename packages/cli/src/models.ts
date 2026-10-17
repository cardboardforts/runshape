// The Node adapters of core's LanguageModel port: `claude -p`, and the Anthropic API.
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

import type { LanguageModel } from "@runshape/core";

/** A model answering a review takes seconds to a minute; past this, something's stuck. */
const MODEL_TIMEOUT_MS = 5 * 60_000;
/** Sonnet: explaining a review is reading and summarising, not deep reasoning. */
export const DEFAULT_API_MODEL = "claude-sonnet-5-5";
const ANTHROPIC_API = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";
/** An explanation is a few hundred words of JSON. */
const MAX_ANSWER_TOKENS = 4096;

/**
 * The person's own `claude` command, headless, signed in however they signed it in. It gets no
 * tools and no customisations (--safe-mode: no CLAUDE.md, hooks, plugins, skills or MCP
 * servers, which would otherwise run on every call and steer the answer), keeps no session, and
 * runs from a temporary directory, away from the project's own .claude settings.
 */
export class ClaudeCliModel implements LanguageModel {
  readonly name = "claude-cli";
  readonly available = true;

  constructor(private readonly command = "claude") {}

  complete(prompt: string): Promise<string> {
    const args = ["-p", "--safe-mode", "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--output-format", "text"];
    return run(this.command, args, prompt).then(({ code, signal, stdout, stderr }) => {
      if (signal !== null) throw new Error(`claude -p was stopped (${signal}), after ${MODEL_TIMEOUT_MS / 60_000} minutes at most`);
      if (code !== 0) throw new Error(`claude -p exited with ${code}: ${stderr.trim() || stdout.trim()}`);
      return stdout;
    });
  }

  /** Whether the command runs at all (installed, on PATH or where RUNSHAPE_CLAUDE says). */
  async runs(): Promise<boolean> {
    return run(this.command, ["--version"], "").then(({ code }) => code === 0, () => false);
  }
}

/** The Anthropic Messages API, by plain fetch: no SDK to install. The key goes in a header, never in a message. */
export class AnthropicApiModel implements LanguageModel {
  readonly available = true;
  readonly name: string;

  constructor(
    private readonly key: string,
    private readonly model = DEFAULT_API_MODEL,
    private baseUrl = ANTHROPIC_API,
  ) {
    this.name = `anthropic:${model}`;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async complete(prompt: string): Promise<string> {
    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": this.key, "anthropic-version": ANTHROPIC_VERSION },
      body: JSON.stringify({ model: this.model, max_tokens: MAX_ANSWER_TOKENS, messages: [{ role: "user", content: prompt }] }),
      signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
    });
    const body = (await response.json().catch(() => ({}))) as { content?: { type: string; text?: string }[]; error?: { message?: string } };
    if (!response.ok) throw new Error(`the Anthropic API answered ${response.status}: ${body.error?.message ?? response.statusText}`);
    return (body.content ?? []).filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
  }
}

export type ModelChoice = "auto" | "claude" | "api";

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

function run(command: string, args: string[], stdin: string): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], timeout: MODEL_TIMEOUT_MS, cwd: tmpdir() });
    // A process that exits without reading leaves a big prompt half written (EPIPE): its exit
    // code says what went wrong; unhandled, the write error would kill the CLI.
    child.stdin.on("error", () => {});
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    child.stdin.end(stdin);
  });
}
