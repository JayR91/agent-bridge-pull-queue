import { getQueue, StorageUnavailable } from "./queue.mjs";

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
    let path = url.pathname.replace(/\/+$/, "") || "/";
    // Vercel rewrites pass `:secret` on the query string when the destination
    // does not contain it (`/pull/:secret` → `/api/pull?secret=`). A dynamic
    // route keeps the segment in `req.url` (`/api/pull/<secret>`), and
    // publicPath strips the `/api` prefix. Fold the query only for the pull
    // function so `/` and `/pull` cannot become pull paths.
    const querySecret = pullSecretFromQuery(url, path);
    if (querySecret) path = `/pull/${querySecret}`;
    return path;
  } catch {
    return "/";
  }
}

function pullSecretFromQuery(url, path) {
  if (path !== "/api/pull" && path !== "/pull") return null;
  const value = url.searchParams.get("pullSecret") || url.searchParams.get("secret");
  if (!value || value.includes("/") || value.includes("\\")) return null;
  return value;
}

function publicPath(path) {
  // `/api/health` → `/health`, `/api/pull/<secret>` → `/pull/<secret>`.
  // `/api` itself is not the public root; `/` is not a pull path.
  if (path.startsWith("/api/")) return path.slice(4) || "/";
  return path;
}

function isHealthPath(path) {
  return path === "/health" || path === "/ok";
}

function configuredPullSecret() {
  const secret = (process.env.PULL_PATH_SECRET ?? "").trim().replace(/^\/+|\/+$/g, "");
  if (!secret || secret.includes("/") || secret.includes("\\")) return "";
  return secret;
}

function isPullPath(path) {
  const secret = configuredPullSecret();
  if (!secret || !path.startsWith("/pull/")) return false;
  const segment = path.slice("/pull/".length);
  if (!segment || segment.includes("/")) return false;
  return timingSafeEqualString(segment, secret);
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

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function commandIdFrom(path) {
  const match = path.match(/^\/(?:result|commands)\/([0-9a-f-]{36})$/i);
  if (!match || !ID_RE.test(match[1])) return null;
  return match[1];
}

function resultView(id, result) {
  let status = null;
  let message = null;
  let hasScreenshot = false;
  try {
    const parsed = JSON.parse(result.body);
    if (parsed && typeof parsed === "object") {
      status = typeof parsed.status === "string" ? parsed.status : null;
      message = typeof parsed.message === "string" ? parsed.message : null;
      hasScreenshot = typeof parsed.screenshotBase64 === "string" && parsed.screenshotBase64.length > 0;
    }
  } catch {
    // The signed bytes are still returned as body.
  }
  return {
    id,
    status,
    message,
    hasScreenshot,
    body: result.body,
    signature: result.signature,
    storedAtEpochMs: result.storedAtEpochMs,
  };
}

async function withQueue(work) {
  try {
    return await work(await getQueue());
  } catch (error) {
    if (error instanceof StorageUnavailable || error?.status === 503) {
      return json(503, { error: error.message });
    }
    throw error;
  }
}

export async function handleRequest(request) {
  const method = request.method.toUpperCase();
  const url = new URL(request.url);
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

  if (method === "GET" && path === "/pull-log") {
    const auth = authorized(request);
    if (auth.missingSecret) return json(503, { error: "QUEUE_SECRET is not configured on this host" });
    if (!auth.ok) return json(401, { error: "Missing or invalid bearer token" });
    return withQueue(async (queue) => {
      const log = await queue.getPullLog();
      return json(200, {
        lastPullEpochMs: log?.lastPullEpochMs ?? null,
        device: log?.device ?? null,
      });
    });
  }

  const recordId = commandIdFrom(path);
  if (recordId && path.startsWith("/commands/")) {
    if (method !== "GET") {
      return json(405, { error: `Method ${method} not allowed on ${path}` }, { Allow: "GET, OPTIONS" });
    }
    const auth = authorized(request);
    if (auth.missingSecret) return json(503, { error: "QUEUE_SECRET is not configured on this host" });
    if (!auth.ok) return json(401, { error: "Missing or invalid bearer token" });
    return withQueue(async (queue) => {
      const command = await queue.getCommand(recordId);
      if (!command) return json(404, { error: "Unknown command id" });
      const result = await queue.getResult(recordId);
      return json(200, {
        id: command.id,
        state: command.state,
        body: command.body,
        signature: command.signature,
        enqueuedAtEpochMs: command.enqueuedAtEpochMs,
        pulledAtEpochMs: command.pulledAtEpochMs,
        result: result
          ? {
              status: resultView(recordId, result).status,
              message: resultView(recordId, result).message,
              hasScreenshot: resultView(recordId, result).hasScreenshot,
              storedAtEpochMs: result.storedAtEpochMs,
            }
          : null,
      });
    });
  }

  if (recordId && path.startsWith("/result/")) {
    if (method === "GET") {
      const auth = authorized(request);
      if (auth.missingSecret) return json(503, { error: "QUEUE_SECRET is not configured on this host" });
      if (!auth.ok) return json(401, { error: "Missing or invalid bearer token" });
      return withQueue(async (queue) => {
        const result = await queue.getResult(recordId);
        if (!result) return json(404, { error: "No result for this command yet" });
        return json(200, resultView(recordId, result));
      });
    }
    if (method === "POST") {
      const signature = request.headers.get("x-signature")?.trim() ?? "";
      if (!isHex(signature)) {
        return json(400, { error: "X-Signature must be HMAC-SHA256 hex of the result body" });
      }
      const rawText = await request.text();
      if (!rawText) return json(400, { error: "Result body is required" });
      return withQueue(async (queue) => {
        const saved = await queue.saveResult(recordId, {
          body: rawText,
          signature: signature.toLowerCase(),
          storedAtEpochMs: Date.now(),
        });
        if (!saved) return json(404, { error: "Unknown command id" });
        return json(200, { ok: true, id: recordId });
      });
    }
  }

  if (method === "GET" && isPullPath(path)) {
    return withQueue(async (queue) => {
      const device = (request.headers.get("x-device") || "").trim().slice(0, 120);
      const commands = await queue.pull({
        limit: url.searchParams.get("limit"),
        device,
        now: Date.now(),
      });
      if (commands.length === 0) return empty(204);
      return json(200, { commands });
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

    return withQueue(async (queue) => {
      const id = await queue.enqueue({
        body: parsed.body,
        signature: parsed.signature,
        storedAtEpochMs: Date.now(),
      });
      return json(200, { ok: true, id });
    });
  }

  return json(405, { error: `Method ${method} not allowed on ${path}` }, { Allow: "GET, PUT, POST, OPTIONS" });
}
