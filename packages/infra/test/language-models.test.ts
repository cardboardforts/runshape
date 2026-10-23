/**
 * The two language models infra offers (core's LanguageModel port, by shape), each against a stand-in: a script in place
 * of `claude`, a local server in place of the Anthropic API. What's checked is what crosses
 * the boundary: the prompt goes in on stdin or in the body, the model gets no tools, the key
 * goes in a header and never into an error message.
 */
import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, IncomingMessage } from "node:http";
import { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { AnthropicApiModel, ClaudeCliModel } from "../src";

function standInClaude(script: string): { command: string; seen: string } {
  const directory = mkdtempSync(join(tmpdir(), "runshape-claude-"));
  const seen = join(directory, "seen.txt");
  const command = join(directory, "claude");
  writeFileSync(command, `#!/bin/sh\nprintf '%s\\n' "$@" > "${seen}"\npwd >> "${seen}"\necho --- >> "${seen}"\ncat >> "${seen}"\n${script}\n`);
  chmodSync(command, 0o755);
  return { command, seen };
}

describe("ClaudeCliModel (claude -p)", () => {
  test("the prompt goes in on stdin; no tools, no customisations (CLAUDE.md, hooks, plugins, MCP), no session, run from a temporary directory", async () => {
    // Without --safe-mode, -p loads the person's and the project's hooks and CLAUDE.md: hooks
    // would run on every explanation and see the prompt, and CLAUDE.md would steer the answer.
    const { command, seen } = standInClaude('echo "{\\"summary\\": \\"ok\\"}"');

    const answer = await new ClaudeCliModel(command).complete("explain this change");

    expect({ answer: answer.trim(), seen: readFileSync(seen, "utf8").split("\n") }).toEqual({
      answer: '{"summary": "ok"}',
      seen: ["-p", "--safe-mode", "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--output-format", "text", realpathSync(tmpdir()), "---", "explain this change"],
    });
  });

  test("a claude that exits without reading a big prompt is a failure to report, not a crash (second-model review)", async () => {
    // Past the pipe's buffer, writing to a process that's gone raises EPIPE: unhandled, it
    // would kill the CLI before "explaining failed (the review is saved)".
    const command = join(mkdtempSync(join(tmpdir(), "runshape-claude-")), "claude");
    writeFileSync(command, '#!/bin/sh\necho "not logged in" >&2\nexit 1\n'); // never reads stdin
    chmodSync(command, 0o755);
    const big = "x".repeat(5 * 1024 * 1024);

    await expect(new ClaudeCliModel(command).complete(big)).rejects.toThrowError("claude -p exited with 1: not logged in");
  });

  test("a failed run says why, from its stderr", async () => {
    const { command } = standInClaude('echo "not logged in" >&2; exit 3');

    await expect(new ClaudeCliModel(command).complete("x")).rejects.toThrowError("claude -p exited with 3: not logged in");
  });
});

async function standInApi(respond: (request: IncomingMessage, body: string) => { status: number; body: unknown }) {
  const seen: { headers: IncomingMessage["headers"]; body: unknown }[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      seen.push({ headers: request.headers, body: JSON.parse(body) });
      const answer = respond(request, body);
      response.writeHead(answer.status, { "content-type": "application/json" });
      response.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close: () => server.close() };
}

describe("AnthropicApiModel", () => {
  test("posts the prompt as one user message with the key in a header; the answer is the text it returns", async () => {
    const api = await standInApi(() => ({ status: 200, body: { content: [{ type: "text", text: '{"summary":' }, { type: "text", text: ' "ok"}' }] } }));

    const answer = await new AnthropicApiModel("sk-test-key", "claude-sonnet-5-5", api.url).complete("explain this change");
    api.close();

    expect({ answer, key: api.seen[0]!.headers["x-api-key"], version: api.seen[0]!.headers["anthropic-version"], body: api.seen[0]!.body }).toEqual({
      answer: '{"summary": "ok"}',
      key: "sk-test-key",
      version: "2023-06-01",
      body: { model: "claude-sonnet-5-5", max_tokens: 4096, messages: [{ role: "user", content: "explain this change" }] },
    });
  });

  test("an error says what the API said, and never the key", async () => {
    const api = await standInApi(() => ({ status: 401, body: { error: { type: "authentication_error", message: "invalid x-api-key" } } }));

    const failure = await new AnthropicApiModel("sk-secret-key", "claude-sonnet-5-5", api.url).complete("x").catch((error: Error) => error.message);
    api.close();

    expect({ failure, leaksKey: String(failure).includes("sk-secret") }).toEqual({ failure: "the Anthropic API answered 401: invalid x-api-key", leaksKey: false });
  });
});
