import { createServer } from "node:http";
import { handleRequest } from "./lib/handler.mjs";
import { nodeToRequest } from "./lib/node-request.mjs";

const PORT = Number.parseInt(process.env.PORT || "43177", 10);
const HOST = process.env.HOST || "0.0.0.0";

const server = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const response = await handleRequest(
      nodeToRequest(req, chunks, { fallbackProto: "http", fallbackHost: `127.0.0.1:${PORT}` }),
    );
    const headers = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const body = Buffer.from(await response.arrayBuffer());
    res.writeHead(response.status, headers);
    res.end(body);
  } catch {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Internal error" }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`agent-bridge-pull-queue listening on http://${HOST}:${PORT}`);
});
