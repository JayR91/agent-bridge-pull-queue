export function requestUrlFromNode(req, { fallbackProto = "https", fallbackHost = "localhost" } = {}) {
  const headers = req.headers || {};
  const host = headers.host || fallbackHost;
  const proto = headers["x-forwarded-proto"] || fallbackProto;
  const url = new URL(req.url || "/", `${proto}://${host}`);
  const query = req.query;
  if (query && typeof query === "object") {
    for (const [key, value] of Object.entries(query)) {
      if (url.searchParams.has(key)) continue;
      const values = Array.isArray(value) ? value : [value];
      for (const item of values) {
        if (typeof item === "string") url.searchParams.append(key, item);
      }
    }
  }
  return url;
}

export function nodeToRequest(req, chunks, options) {
  const url = requestUrlFromNode(req, options);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers || {})) {
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
