import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { handleRequest } from "./lib/handler.mjs";

const SECRET = "test-queue-secret-0123456789abcdef";
const BODY =
  '{"actionId":"arattai.clear_chat","params":{"chatName":"Nivetha"},"dryRun":true,"issuedAtEpochMs":1730000000000,"nonce":"n-1"}';
const SIG = "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";

async function withSecret(fn) {
  const previous = process.env.QUEUE_SECRET;
  process.env.QUEUE_SECRET = SECRET;
  try {
    await handleRequest(new Request("http://127.0.0.1/"));
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.QUEUE_SECRET;
    else process.env.QUEUE_SECRET = previous;
  }
}

test("GET is 204 when the queue is empty", async () => {
  await withSecret(async () => {
    await handleRequest(
      new Request("http://127.0.0.1/", {
        method: "PUT",
        headers: { authorization: `Bearer ${SECRET}`, "x-signature": SIG },
        body: BODY,
      }),
    );
    await handleRequest(new Request("http://127.0.0.1/"));
    const res = await handleRequest(new Request("http://127.0.0.1/"));
    assert.equal(res.status, 204);
    assert.equal(await res.text(), "");
  });
});

test("PUT raw body + X-Signature then one-shot GET", async () => {
  await withSecret(async () => {
    const put = await handleRequest(
      new Request("http://127.0.0.1/", {
        method: "PUT",
        headers: {
          authorization: `Bearer ${SECRET}`,
          "content-type": "application/json",
          "x-signature": SIG,
        },
        body: BODY,
      }),
    );
    assert.equal(put.status, 200);

    const got = await handleRequest(new Request("http://127.0.0.1/pull"));
    assert.equal(got.status, 200);
    assert.equal(got.headers.get("x-signature"), SIG);
    assert.equal(await got.text(), BODY);

    const empty = await handleRequest(new Request("http://127.0.0.1/"));
    assert.equal(empty.status, 204);
  });
});

test("POST /enqueue stores a string body envelope", async () => {
  await withSecret(async () => {
    const put = await handleRequest(
      new Request("http://127.0.0.1/enqueue", {
        method: "POST",
        headers: {
          authorization: `Bearer ${SECRET}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ body: BODY, signature: SIG }),
      }),
    );
    assert.equal(put.status, 200);
    const got = await handleRequest(new Request("http://127.0.0.1/"));
    assert.equal(await got.text(), BODY);
    assert.equal(got.headers.get("x-signature"), SIG);
  });
});

test("POST /enqueue stores an object body as compact JSON", async () => {
  await withSecret(async () => {
    const payload = JSON.parse(BODY);
    const put = await handleRequest(
      new Request("http://127.0.0.1/enqueue", {
        method: "POST",
        headers: {
          authorization: `Bearer ${SECRET}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ body: payload, signature: SIG }),
      }),
    );
    assert.equal(put.status, 200);
    const got = await handleRequest(new Request("http://127.0.0.1/"));
    assert.equal(await got.text(), JSON.stringify(payload));
  });
});

test("writes without bearer are 401", async () => {
  await withSecret(async () => {
    const res = await handleRequest(
      new Request("http://127.0.0.1/", {
        method: "PUT",
        headers: { "x-signature": SIG },
        body: BODY,
      }),
    );
    assert.equal(res.status, 401);
  });
});

test("local HTTP server serves GET 204", async () => {
  const port = 43178;
  const child = spawn(process.execPath, ["server.mjs"], {
    env: { ...process.env, PORT: String(port), QUEUE_SECRET: SECRET },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await Promise.race([
      once(child.stdout, "data"),
      delay(3000).then(() => {
        throw new Error("server did not start");
      }),
    ]);
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 204);
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit").catch(() => {});
  }
});
