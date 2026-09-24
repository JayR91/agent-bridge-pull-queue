import { handleRequest } from "../lib/handler.mjs";
import { nodeToRequest } from "../lib/node-request.mjs";

export const preferredRegion = "iad1";

export const config = {
  api: {
    bodyParser: false,
  },
};

async function readChunks(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return chunks;
}

function bodyChunksFromParsed(req) {
  if (typeof req.body === "string") return [Buffer.from(req.body)];
  if (Buffer.isBuffer(req.body)) return [req.body];
  if (req.body instanceof Uint8Array) return [Buffer.from(req.body)];
  if (req.body && typeof req.body === "object") return [Buffer.from(JSON.stringify(req.body))];
  return [];
}

function sendNodeResponse(res, response) {
  if (!res || typeof res.writeHead !== "function") return response;
  const headers = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return response.arrayBuffer().then((buffer) => {
    res.writeHead(response.status, headers);
    res.end(Buffer.from(buffer));
  });
}

export default async function handler(req, res) {
  try {
    if (typeof Request !== "undefined" && req instanceof Request) {
      return handleRequest(req);
    }

    const chunks =
      req.readable && req.readableEnded === false ? await readChunks(req) : bodyChunksFromParsed(req);
    const response = await handleRequest(nodeToRequest(req, chunks));
    return sendNodeResponse(res, response);
  } catch {
    const response = new Response(JSON.stringify({ error: "Internal error" }), {
      status: 500,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "private, no-store, no-cache, must-revalidate, max-age=0",
      },
    });
    return sendNodeResponse(res, response);
  }
}
