import { handleRequest } from "../lib/handler.mjs";

export const preferredRegion = "iad1";

export const config = {
  api: {
    bodyParser: false,
  },
};

function queryValue(value) {
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : "";
  return typeof value === "string" ? value : "";
}

function requestTarget(req) {
  const raw = req.url || "/";
  const host = req.headers.host || "localhost";
  const absolute =
    raw.startsWith("http://") || raw.startsWith("https://")
      ? raw
      : `http://${host}${raw.startsWith("/") ? raw : `/${raw}`}`;
  let url;
  try {
    url = new URL(absolute);
  } catch {
    return raw;
  }
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (/\/\[secret\](?:\.js)?$/.test(path)) {
    const fromQuery = queryValue(req.query?.secret);
    if (fromQuery && !url.searchParams.get("secret")) {
      url.searchParams.set("secret", fromQuery);
    }
  }
  return `${url.pathname}${url.search}`;
}

function nodeToRequest(req, chunks) {
  const host = req.headers.host || "localhost";
  const proto = req.headers["x-forwarded-proto"] || "https";
  const url = `${proto}://${host}${requestTarget(req)}`;
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
