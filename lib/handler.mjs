import { getQueue } from "./queue.mjs";

const NO_STORE = {
  "Cache-Control": "private, no-store, no-cache, must-revalidate, max-age=0",
  "CDN-Cache-Control": "no-store",
  "Vercel-CDN-Cache-Control": "no-store",
};

function json(status, payload, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...NO_STORE,
      ...extraHeaders,
    },
  });
}

function empty(status) {
  return new Response(null, { status, headers: NO_STORE });
}

function pathnameOf(request) {
  try {
    const url = new URL(request.url);
    const original = url.pathname.replace(/\/+$/, "") || "/";
    // Vercel serves api/pull/[secret].js at a function path like
    // /api/pull/[secret].js?secret=<segment>, not the public /pull/<segment>.
    if (/\/\[secret\](?:\.js)?$/.test(original)) {
      const secret = url.searchParams.get("secret");
      if (secret && !secret.includes("/")) return `/pull/${encodeURIComponent(secret)}`;
      return "/pull";
    }
    return publicPath(original);
  } catch {
    return "/";
  }
}

function publicPath(path) {
  if (path === "/api" || path === "/api/index") return "/";
  if (path.startsWith("/api/")) return path.slice(4) || "/";
  return path;
}

function isHealthPath(path) {
  return path === "/health" || path === "/ok";
}

function pullPathSegment(path) {
  const prefix = "/pull/";
  if (!path.startsWith(prefix)) return null;
  const segment = path.slice(prefix.length);
  if (!segment || segment.includes("/")) return null;
  try {
    const decoded = decodeURIComponent(segment);
    if (!decoded || decoded.includes("/")) return null;
    return decoded;
  } catch {
    return segment;
  }
}

function isPullPath(path) {
  const secret = process.env.PULL_PATH_SECRET ?? "";
  if (secret) {
    const segment = pullPathSegment(path);
    return segment !== null && timingSafeEqualString(segment, secret);
  }
  return path === "/" || path === "/pull";
}

function isEnqueuePath(path) {
  return isPullPath(path) || path === "/enqueue";
}

function timingSafeEqualString(a, b) {
  const left = String(a ?? "");
  const right = String(b ?? "");
  const max = Math.max(left.length, right.length, 1);
  let diff = left.length === right.length ? 0 : 1;
  for (let i = 0; i < max; i += 1) {
    diff |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function authorized(request) {
  const secret = process.env.QUEUE_SECRET ?? "";
  if (!secret) return { ok: false, missingSecret: true };
  const header = request.headers.get("authorization") ?? "";
  const presented = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  return { ok: timingSafeEqualString(presented, secret), missingSecret: false };
}

function isHex(value) {
  return typeof value === "string" && /^[0-9a-fA-F]+$/.test(value) && value.length >= 32;
}

function compactBody(value) {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

async function parseEnqueue(request, rawText) {
  const headerSig = request.headers.get("x-signature")?.trim() ?? "";
  if (headerSig) {
    if (!rawText) {
      return { error: "Raw body is required when X-Signature is set", status: 400 };
    }
    if (!isHex(headerSig)) {
      return { error: "X-Signature must be HMAC-SHA256 hex", status: 400 };
    }
    return { body: rawText, signature: headerSig.toLowerCase() };
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { error: "JSON body with { body, signature } is required when X-Signature is omitted", status: 400 };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "Enqueue JSON must be an object", status: 400 };
  }

  const signature = typeof parsed.signature === "string" ? parsed.signature.trim() : "";
  if (!isHex(signature)) {
    return { error: "signature must be HMAC-SHA256 hex", status: 400 };
  }
  if (parsed.body === undefined || parsed.body === null) {
    return { error: "body is required", status: 400 };
  }
  if (typeof parsed.body !== "string" && (typeof parsed.body !== "object" || Array.isArray(parsed.body))) {
    return { error: "body must be a SignedCommandPayload object or a JSON string", status: 400 };
  }

  const body = compactBody(parsed.body);
  if (!body) {
    return { error: "body must not be empty", status: 400 };
  }
  return { body, signature: signature.toLowerCase() };
}

export async function handleRequest(request) {
  const method = request.method.toUpperCase();
  const path = publicPath(pathnameOf(request));

  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...NO_STORE,
        Allow: "GET, PUT, POST, OPTIONS",
      },
    });
  }

  if (method === "GET" && isHealthPath(path)) {
    return json(200, { ok: true, service: "agent-bridge-pull-queue" });
  }

  if (method === "GET" && isPullPath(path)) {
    const queue = await getQueue();
    const item = await queue.read();
    if (!item?.body || !item?.signature) {
      return empty(204);
    }
    await queue.clear();
    return new Response(item.body, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "X-Signature": item.signature,
        ...NO_STORE,
      },
    });
  }

  if ((method === "PUT" || method === "POST") && isEnqueuePath(path)) {
    const auth = authorized(request);
    if (auth.missingSecret) {
      return json(503, { error: "QUEUE_SECRET is not configured on this host" });
    }
    if (!auth.ok) {
      return json(401, { error: "Missing or invalid bearer token" });
    }

    const rawText = await request.text();
    const parsed = await parseEnqueue(request, rawText);
    if (parsed.error) {
      return json(parsed.status, { error: parsed.error });
    }

    const queue = await getQueue();
    await queue.write({
      body: parsed.body,
      signature: parsed.signature,
      storedAtEpochMs: Date.now(),
    });
    return json(200, { ok: true });
  }

  return json(405, { error: `Method ${method} not allowed on ${path}` }, { Allow: "GET, PUT, POST, OPTIONS" });
}
