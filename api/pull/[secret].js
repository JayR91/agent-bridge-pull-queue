// Vercel may call this file with req.url `/api/pull/[secret].js?secret=…`
// or `/?secret=…`. Restore the public `/pull/<segment>` before the shared handler.
import nodeHandler, { config, preferredRegion } from "../index.js";

export { config, preferredRegion };

function queryValue(value) {
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : "";
  return typeof value === "string" ? value : "";
}

function realPullSegment(pathname) {
  const path = pathname.replace(/\/+$/, "") || "/";
  const normalized =
    path === "/api" || path === "/api/index" ? "/" : path.startsWith("/api/") ? path.slice(4) || "/" : path;
  if (!normalized.startsWith("/pull/")) return "";
  const segment = normalized.slice("/pull/".length);
  if (!segment || segment.includes("/") || segment === "[secret]" || segment === "[secret].js") return "";
  return segment;
}

function searchWithoutSecret(search, secretAlreadyUsed) {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  if (secretAlreadyUsed) params.delete("secret");
  const rest = params.toString();
  return rest ? `?${rest}` : "";
}

function publicPullTarget(pathname, search, querySecret) {
  const segment = realPullSegment(pathname);
  if (segment) return `/pull/${segment}${search}`;
  const secret = querySecret || "";
  if (!secret || secret.includes("/")) return `${pathname}${search}`;
  return `/pull/${encodeURIComponent(secret)}${searchWithoutSecret(search, true)}`;
}

function applyPublicPullPath(req) {
  if (typeof Request !== "undefined" && req instanceof Request) {
    const url = new URL(req.url);
    const next = publicPullTarget(url.pathname, url.search, url.searchParams.get("secret") || "");
    if (next === `${url.pathname}${url.search}`) return req;
    const rewritten = new URL(req.url);
    const hash = rewritten.hash;
    const parsed = new URL(next, rewritten.origin);
    rewritten.pathname = parsed.pathname;
    rewritten.search = parsed.search;
    rewritten.hash = hash;
    return new Request(rewritten, req);
  }

  const raw = req.url || "/";
  let pathname = "/";
  let search = "";
  try {
    const parsed = new URL(raw, "http://localhost");
    pathname = parsed.pathname;
    search = parsed.search;
  } catch {
    return req;
  }
  const secret = queryValue(req.query?.secret) || new URLSearchParams(search).get("secret") || "";
  const next = publicPullTarget(pathname, search, secret);
  if (next !== `${pathname}${search}`) req.url = next;
  return req;
}

export default function handler(req, res) {
  return nodeHandler(applyPublicPullPath(req), res);
}
