import { handleRequest } from "../lib/handler.mjs";

export const preferredRegion = "iad1";

export const config = {
  api: {
    bodyParser: false,
  },
};

function nodeToRequest(req, chunks) {
  const host = req.headers.host || "localhost";
  const proto = req.headers["x-forwarded-proto"] || "https";
  const url = `${proto}://${host}${req.url}`;
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

export default async function handler(req, res) {
  if (typeof Request !== "undefined" && req instanceof Request) {
    return handleRequest(req);
  }

  const chunks =
    req.readable && req.readableEnded === false ? await readChunks(req) : bodyChunksFromParsed(req);
  const response = await handleRequest(nodeToRequest(req, chunks));
  if (!res || typeof res.writeHead !== "function") {
    return response;
  }
  const headers = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const body = Buffer.from(await response.arrayBuffer());
  res.writeHead(response.status, headers);
  res.end(body);
}
