import { createServer } from "node:http";
import { handleRequest } from "./lib/handler.mjs";

const PORT = Number.parseInt(process.env.PORT || "43177", 10);
const HOST = process.env.HOST || "0.0.0.0";

function incomingToRequest(req, chunks) {
  const host = req.headers.host || `127.0.0.1:${PORT}`;
  const url = `http://${host}${req.url}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  const method = req.method || "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(url, {
    method,
    headers,
    body: hasBody ? Buffer.concat(chunks) : undefined,
  });
}

const server = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const response = await handleRequest(incomingToRequest(req, chunks));
    const headers = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const body = Buffer.from(await response.arrayBuffer());
    res.writeHead(response.status, headers);
    res.end(body);
  } catch (error) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : "Internal error" }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`agent-bridge-pull-queue listening on http://${HOST}:${PORT}`);
});
