// The install container's only way out: an HTTPS proxy that connects to the npm registry and
// nowhere else. However a lockfile talks npm into fetching (a URL as a version or a name, a git
// dependency), there's nothing else to fetch from. Runs in its own container, built from this
// checkout; docker-recorder.ts starts it. RUNSHAPE_PROXY_ALLOW overrides the host for tests.
import http from "node:http";
import net from "node:net";

const ALLOWED = new Set((process.env.RUNSHAPE_PROXY_ALLOW ?? "registry.npmjs.org:443").split(","));
const PORT = Number(process.env.RUNSHAPE_PROXY_PORT ?? 3128);

const server = http.createServer((_request, response) => {
  // Plain HTTP (a proxied GET to anywhere): never.
  response.writeHead(403, { "content-type": "text/plain" });
  response.end("runshape: only the npm registry, over HTTPS\n");
});

server.on("connect", (request, client, head) => {
  const target = request.url ?? "";
  if (!ALLOWED.has(target)) {
    client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }
  const at = target.lastIndexOf(":");
  const upstream = net.connect(Number(target.slice(at + 1)), target.slice(0, at), () => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  upstream.on("error", () => client.destroy());
  client.on("error", () => upstream.destroy());
});

server.listen(PORT, () => console.log(`runshape registry proxy on :${server.address().port}, allowing ${[...ALLOWED].join(", ")}`));
