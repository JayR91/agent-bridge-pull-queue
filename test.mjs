import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { handleRequest } from "./lib/handler.mjs";
import { requestUrlFromNode } from "./lib/node-request.mjs";
import { queueFromStore, resetQueueForTests } from "./lib/queue.mjs";

const SECRET = "test-queue-secret-0123456789abcdef";
const PULL_SECRET = "test-pull-path-secret";
const PULL = `http://127.0.0.1/pull/${PULL_SECRET}`;
const BODY =
  '{"actionId":"arattai.clear_chat","params":{"chatName":"Nivetha"},"dryRun":true,"issuedAtEpochMs":1730000000000,"nonce":"n-1"}';
const SIG = "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";

async function withSecrets(fn) {
  const previousQueue = process.env.QUEUE_SECRET;
  const previousPull = process.env.PULL_PATH_SECRET;
  process.env.QUEUE_SECRET = SECRET;
  process.env.PULL_PATH_SECRET = PULL_SECRET;
  try {
    await resetQueueForTests();
    return await fn();
  } finally {
    if (previousQueue === undefined) delete process.env.QUEUE_SECRET;
    else process.env.QUEUE_SECRET = previousQueue;
    if (previousPull === undefined) delete process.env.PULL_PATH_SECRET;
    else process.env.PULL_PATH_SECRET = previousPull;
  }
}

async function commandsOf(response) {
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.ok(Array.isArray(payload.commands));
  return payload.commands;
}

async function enqueue(url = PULL, init = {}) {
  return handleRequest(
    new Request(url, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${SECRET}`,
        "content-type": "application/json",
        "x-signature": SIG,
      },
      body: BODY,
      ...init,
    }),
  );
}

test("@vercel/functions is locked for the Vercel install", () => {
  const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(readFileSync(new URL("./package-lock.json", import.meta.url), "utf8"));
  assert.equal(typeof pkg.dependencies["@vercel/functions"], "string");
  const locked = lock.packages?.["node_modules/@vercel/functions"] ?? lock.dependencies?.["@vercel/functions"];
  assert.ok(locked, "package-lock.json must include @vercel/functions");
});

test("GET /health and /ok do not consume a queued command", async () => {
  await withSecrets(async () => {
    assert.equal((await enqueue()).status, 200);

    for (const url of ["http://127.0.0.1/health", "http://127.0.0.1/ok", "http://127.0.0.1/api/health"]) {
      const health = await handleRequest(new Request(url));
      assert.equal(health.status, 200);
      assert.deepEqual(await health.json(), { ok: true, service: "agent-bridge-pull-queue" });
    }

    const [command] = await commandsOf(await handleRequest(new Request(PULL)));
    assert.equal(command.body, BODY);
    assert.equal(command.signature, SIG);
  });
});

test("GET /pull/<secret> is 204 when the queue is empty", async () => {
  await withSecrets(async () => {
    await enqueue();
    await handleRequest(new Request(PULL));
    const res = await handleRequest(new Request(PULL));
    assert.equal(res.status, 204);
    assert.equal(await res.text(), "");
  });
});

test("PUT /pull/<secret> raw body + X-Signature then one-shot GET", async () => {
  await withSecrets(async () => {
    const put = await enqueue();
    assert.equal(put.status, 200);

    const putBody = await put.json();
    assert.equal(putBody.ok, true);
    assert.match(putBody.id, /^[0-9a-f-]{36}$/i);

    const [command] = await commandsOf(await handleRequest(new Request(`${PULL}/`)));
    assert.equal(command.body, BODY);
    assert.equal(command.signature, SIG);
    assert.equal(command.id, putBody.id);

    const empty = await handleRequest(new Request(`http://127.0.0.1/api/pull/${PULL_SECRET}`));
    assert.equal(empty.status, 204);
  });
});

test("POST /enqueue stores a string body envelope", async () => {
  await withSecrets(async () => {
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
    const [command] = await commandsOf(await handleRequest(new Request(PULL)));
    assert.equal(command.body, BODY);
    assert.equal(command.signature, SIG);
  });
});

test("POST /pull/<secret> stores an object body as compact JSON", async () => {
  await withSecrets(async () => {
    const payload = JSON.parse(BODY);
    const put = await handleRequest(
      new Request(PULL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${SECRET}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ body: payload, signature: SIG }),
      }),
    );
    assert.equal(put.status, 200);
    const [command] = await commandsOf(await handleRequest(new Request(PULL)));
    assert.equal(command.body, JSON.stringify(payload));
  });
});

test("root, bare /pull, and the wrong secret do not pull or enqueue", async () => {
  await withSecrets(async () => {
    assert.equal((await enqueue()).status, 200);

    for (const url of [
      "http://127.0.0.1/",
      "http://127.0.0.1/pull",
      "http://127.0.0.1/pull/",
      "http://127.0.0.1/api",
      "http://127.0.0.1/api/index",
      `http://127.0.0.1/pull/not-${PULL_SECRET}`,
      `http://127.0.0.1/?pullSecret=${PULL_SECRET}`,
      `http://127.0.0.1/api?secret=${PULL_SECRET}`,
      `http://127.0.0.1/api?pullSecret=${PULL_SECRET}`,
    ]) {
      const res = await handleRequest(new Request(url));
      assert.notEqual(res.status, 200, url);
      assert.notEqual(res.status, 204, url);
      assert.equal(res.status, 405, url);
    }

    const putRoot = await handleRequest(
      new Request("http://127.0.0.1/", {
        method: "PUT",
        headers: { authorization: `Bearer ${SECRET}`, "x-signature": SIG },
        body: BODY,
      }),
    );
    assert.equal(putRoot.status, 405);

    const [command] = await commandsOf(await handleRequest(new Request(PULL)));
    assert.equal(command.body, BODY);
  });
});

test("Vercel rewrite shapes still reach the secret pull path", async () => {
  await withSecrets(async () => {
    const shapes = [
      `http://127.0.0.1/api/pull/${PULL_SECRET}`,
      `http://127.0.0.1/api/pull?pullSecret=${encodeURIComponent(PULL_SECRET)}`,
      `http://127.0.0.1/api/pull?secret=${encodeURIComponent(PULL_SECRET)}`,
      `http://127.0.0.1/pull?secret=${encodeURIComponent(PULL_SECRET)}`,
    ];
    for (const url of shapes) {
      assert.equal((await enqueue(url)).status, 200, url);
      const [command] = await commandsOf(await handleRequest(new Request(url)));
      assert.equal(command.body, BODY, url);
      assert.equal(command.signature, SIG, url);
      assert.equal((await handleRequest(new Request(url))).status, 204, url);
    }
  });
});

test("dynamic route query is copied onto the request URL before handling", async () => {
  await withSecrets(async () => {
    const url = requestUrlFromNode({
      headers: { host: "queue.test" },
      url: "/api/pull",
      query: { secret: PULL_SECRET },
    });
    assert.equal(url.searchParams.get("secret"), PULL_SECRET);
    const res = await handleRequest(new Request(url));
    assert.equal(res.status, 204);

    const untouched = requestUrlFromNode({
      headers: { host: "queue.test" },
      url: "/api/pull?secret=already",
      query: { secret: PULL_SECRET },
    });
    assert.equal(untouched.searchParams.get("secret"), "already");
    assert.equal((await handleRequest(new Request(untouched))).status, 405);
  });
});

test("writes without bearer are 401", async () => {
  await withSecrets(async () => {
    const res = await handleRequest(
      new Request(PULL, {
        method: "PUT",
        headers: { "x-signature": SIG },
        body: BODY,
      }),
    );
    assert.equal(res.status, 401);
  });
});

test("without PULL_PATH_SECRET, / and /pull are not pull paths", async () => {
  const previous = process.env.PULL_PATH_SECRET;
  delete process.env.PULL_PATH_SECRET;
  const previousQueue = process.env.QUEUE_SECRET;
  process.env.QUEUE_SECRET = SECRET;
  try {
    for (const url of ["http://127.0.0.1/", "http://127.0.0.1/pull", `http://127.0.0.1/pull/${PULL_SECRET}`]) {
      assert.equal((await handleRequest(new Request(url))).status, 405, url);
    }
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
  } finally {
    if (previous === undefined) delete process.env.PULL_PATH_SECRET;
    else process.env.PULL_PATH_SECRET = previous;
    if (previousQueue === undefined) delete process.env.QUEUE_SECRET;
    else process.env.QUEUE_SECRET = previousQueue;
  }
});

test("enqueue assigns ids and pull returns FIFO order", async () => {
  await withSecrets(async () => {
    const first = await enqueue();
    const firstId = (await first.json()).id;
    const secondBody = BODY.replace("n-1", "n-2");
    const second = await handleRequest(
      new Request(PULL, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${SECRET}`,
          "content-type": "application/json",
          "x-signature": SIG,
        },
        body: secondBody,
      }),
    );
    const secondId = (await second.json()).id;
    assert.notEqual(firstId, secondId);

    const batch = await commandsOf(await handleRequest(new Request(`${PULL}?limit=1`)));
    assert.equal(batch.length, 1);
    assert.equal(batch[0].id, firstId);
    assert.equal(batch[0].body, BODY);

    const next = await commandsOf(await handleRequest(new Request(PULL)));
    assert.equal(next[0].id, secondId);
    assert.equal(next[0].body, secondBody);
  });
});

test("phone posts a signed result and the bot can poll it", async () => {
  await withSecrets(async () => {
    const enqueued = await enqueue();
    const { id } = await enqueued.json();
    await handleRequest(new Request(PULL, { headers: { "x-device": "realme RMX3312" } }));

    const resultBody = JSON.stringify({
      status: "succeeded",
      message: "snapshot tree",
      screenshotBase64: "aGVsbG8=",
    });
    const posted = await handleRequest(
      new Request(`http://127.0.0.1/result/${id}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-signature": SIG,
        },
        body: resultBody,
      }),
    );
    assert.equal(posted.status, 200);

    const denied = await handleRequest(new Request(`http://127.0.0.1/result/${id}`));
    assert.equal(denied.status, 401);

    const got = await handleRequest(
      new Request(`http://127.0.0.1/result/${id}`, {
        headers: { authorization: `Bearer ${SECRET}` },
      }),
    );
    assert.equal(got.status, 200);
    const payload = await got.json();
    assert.equal(payload.body, resultBody);
    assert.equal(payload.signature, SIG);
    assert.equal(payload.status, "succeeded");
    assert.equal(payload.message, "snapshot tree");
    assert.equal(payload.hasScreenshot, true);

    const command = await handleRequest(
      new Request(`http://127.0.0.1/commands/${id}`, {
        headers: { authorization: `Bearer ${SECRET}` },
      }),
    );
    const commandBody = await command.json();
    assert.equal(commandBody.state, "done");
    assert.equal(commandBody.result.message, "snapshot tree");

    const log = await handleRequest(
      new Request("http://127.0.0.1/pull-log", {
        headers: { authorization: `Bearer ${SECRET}` },
      }),
    );
    const logBody = await log.json();
    assert.equal(logBody.device, "realme RMX3312");
    assert.equal(typeof logBody.lastPullEpochMs, "number");
  });
});

test("a Runtime Cache shaped store keeps FIFO order without Upstash", async () => {
  const map = new Map();
  const store = {
    async get(key) {
      return map.has(key) ? JSON.parse(JSON.stringify(map.get(key))) : null;
    },
    async set(key, value) {
      map.set(key, JSON.parse(JSON.stringify(value)));
    },
    async delete(key) {
      map.delete(key);
    },
  };
  const queue = queueFromStore(store);
  const first = await queue.enqueue({ body: BODY, signature: SIG, storedAtEpochMs: 1 });
  const second = await queue.enqueue({ body: BODY.replace("n-1", "n-2"), signature: SIG, storedAtEpochMs: 2 });
  const pulled = await queue.pull({ limit: 1, device: "phone", now: 10 });
  assert.equal(pulled.length, 1);
  assert.equal(pulled[0].id, first);
  assert.equal(pulled[0].body, BODY);
  assert.equal(await queue.saveResult(first, { body: '{"status":"succeeded","message":"ok"}', signature: SIG, storedAtEpochMs: 11 }), true);
  assert.equal(JSON.parse((await queue.getResult(first)).body).message, "ok");
  const next = await queue.pull({ limit: 5, device: "phone", now: 12 });
  assert.equal(next[0].id, second);
  assert.equal((await queue.getPullLog()).device, "phone");
  assert.equal(map.has("agent-bridge:fifo"), true);
});

test("VERCEL without Upstash still enqueues and pulls", async () => {
  const previousVercel = process.env.VERCEL;
  const previousUrl = process.env.UPSTASH_REDIS_REST_URL;
  const previousToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.VERCEL = "1";
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  try {
    await withSecrets(async () => {
      const put = await enqueue();
      assert.equal(put.status, 200);
      const { id } = await put.json();
      assert.match(id, /^[0-9a-f-]{36}$/i);
      const [command] = await commandsOf(await handleRequest(new Request(PULL)));
      assert.equal(command.id, id);
      assert.equal(command.body, BODY);
    });
  } finally {
    if (previousVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previousVercel;
    if (previousUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = previousUrl;
    if (previousToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = previousToken;
  }
});

test("local HTTP server does not pull / and does pull /pull/<secret>", async () => {
  const port = 43178;
  const child = spawn(process.execPath, ["server.mjs"], {
    env: {
      ...process.env,
      PORT: String(port),
      QUEUE_SECRET: SECRET,
      PULL_PATH_SECRET: PULL_SECRET,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await Promise.race([
      once(child.stdout, "data"),
      delay(3000).then(() => {
        throw new Error("server did not start");
      }),
    ]);
    const root = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(root.status, 405);
    const bare = await fetch(`http://127.0.0.1:${port}/pull`);
    assert.equal(bare.status, 405);
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
    const pull = await fetch(`http://127.0.0.1:${port}/pull/${PULL_SECRET}`);
    assert.equal(pull.status, 204);
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit").catch(() => {});
  }
});
