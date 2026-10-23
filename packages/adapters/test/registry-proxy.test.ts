/**
 * The install container's only way out (recorder-ts/sandbox/registry-proxy.mjs): HTTPS to the
 * npm registry and nothing else. Run for real here, allowing a local stand-in for the registry.
 */
import { spawn } from "node:child_process";
import { request } from "node:http";
import { createServer } from "node:net";
import { join } from "node:path";

import { expect, test } from "vitest";

const PROXY = join(import.meta.dirname, "..", "..", "..", "recorder-ts", "sandbox", "registry-proxy.mjs");

/** Asks the proxy to tunnel to `target` (CONNECT), or to fetch a URL for us (a plain GET). */
function ask(port: number, method: "CONNECT" | "GET", target: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path: target });
    req.on("connect", (response, socket) => {
      socket.destroy();
      resolve(response.statusCode ?? 0);
    });
    req.on("response", (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

test("tunnels to the registry only: anywhere else, or a plain HTTP fetch, is refused", async () => {
  const registry = createServer((socket) => socket.end());
  await new Promise<void>((resolve) => registry.listen(0, "127.0.0.1", resolve));
  const registryAt = `127.0.0.1:${(registry.address() as { port: number }).port}`;
  // Port 0: whichever is free, as the proxy says once it's listening.
  const proxy = spawn(process.execPath, [PROXY], { env: { ...process.env, RUNSHAPE_PROXY_ALLOW: registryAt, RUNSHAPE_PROXY_PORT: "0" }, stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise<number>((resolve) => proxy.stdout.once("data", (chunk: Buffer) => resolve(Number(/on :(\d+)/.exec(chunk.toString())![1]))));

  try {
    expect({
      registry: await ask(port, "CONNECT", registryAt),
      elsewhere: await ask(port, "CONNECT", "evil.example:443"),
      hostMachine: await ask(port, "CONNECT", "host.docker.internal:5173"),
      plainHttp: await ask(port, "GET", "http://127.0.0.1:8765/evil.tgz"),
    }).toEqual({ registry: 200, elsewhere: 403, hostMachine: 403, plainHttp: 403 });
  } finally {
    proxy.kill();
    registry.close();
  }
});
