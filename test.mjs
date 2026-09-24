import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import nodeHandler from "./api/index.js";
import pullSecretHandler from "./api/pull/[secret].js";
import { handleRequest } from "./lib/handler.mjs";

const SECRET = "test-queue-secret-0123456789abcdef";
const PULL_PATH = "test-pull-path-secret";
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

test("GET /health and /ok return {ok:true} without consuming the queue", async () => {
  await withSecret(async () => {
    const put = await handleRequest(
      new Request("http://127.0.0.1/", {
        method: "PUT",
        headers: { authorization: `Bearer ${SECRET}`, "x-signature": SIG },
        body: BODY,
      }),
    );
    assert.equal(put.status, 200);

    for (const url of ["http://127.0.0.1/health", "http://127.0.0.1/ok", "http://127.0.0.1/api/health"]) {
      const health = await handleRequest(new Request(url));
      assert.equal(health.status, 200);
      assert.deepEqual(await health.json(), { ok: true, service: "agent-bridge-pull-queue" });
    }

    const got = await handleRequest(new Request("http://127.0.0.1/"));
    assert.equal(got.status, 200);
    assert.equal(await got.text(), BODY);
  });
});

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

async function withPullSecret(fn) {
  const previousQueue = process.env.QUEUE_SECRET;
  const previousPull = process.env.PULL_PATH_SECRET;
  process.env.QUEUE_SECRET = SECRET;
  process.env.PULL_PATH_SECRET = PULL_PATH;
  try {
    await handleRequest(new Request(`http://127.0.0.1/pull/${PULL_PATH}`));
    return await fn();
  } finally {
    if (previousQueue === undefined) delete process.env.QUEUE_SECRET;
    else process.env.QUEUE_SECRET = previousQueue;
    if (previousPull === undefined) delete process.env.PULL_PATH_SECRET;
    else process.env.PULL_PATH_SECRET = previousPull;
  }
}

function mockRes() {
  return {
    statusCode: 0,
    headers: {},
    body: Buffer.alloc(0),
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers || {};
    },
    end(body) {
      if (body) this.body = Buffer.isBuffer(body) ? body : Buffer.from(body);
    },
  };
}

async function invokeNode(handler, req) {
  const res = mockRes();
  await handler(
    {
      readable: false,
      headers: { host: "127.0.0.1" },
      ...req,
    },
    res,
  );
  return res;
}

async function enqueueOnSecretPath() {
  const put = await handleRequest(
    new Request(`http://127.0.0.1/pull/${PULL_PATH}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${SECRET}`, "x-signature": SIG },
      body: BODY,
    }),
  );
  assert.equal(put.status, 200);
}

test("secret path is the only pull and path-enqueue route", async () => {
  await withPullSecret(async () => {
    await enqueueOnSecretPath();

    for (const url of [
      "http://127.0.0.1/",
      "http://127.0.0.1/pull",
      "http://127.0.0.1/pull/wrong-secret",
      `http://127.0.0.1/pull?secret=${PULL_PATH}`,
    ]) {
      const missed = await handleRequest(new Request(url));
      assert.equal(missed.status, 405);
    }

    const rootPut = await handleRequest(
      new Request("http://127.0.0.1/", {
        method: "PUT",
        headers: { authorization: `Bearer ${SECRET}`, "x-signature": SIG },
        body: BODY,
      }),
    );
    assert.equal(rootPut.status, 405);

    const got = await handleRequest(new Request(`http://127.0.0.1/pull/${PULL_PATH}`));
    assert.equal(got.status, 200);
    assert.equal(got.headers.get("x-signature"), SIG);
    assert.equal(await got.text(), BODY);

    const empty = await handleRequest(new Request(`http://127.0.0.1/pull/${PULL_PATH}`));
    assert.equal(empty.status, 204);

    const health = await handleRequest(new Request("http://127.0.0.1/health"));
    assert.equal(health.status, 200);
    const enq = await handleRequest(
      new Request("http://127.0.0.1/enqueue", {
        method: "POST",
        headers: {
          authorization: `Bearer ${SECRET}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ body: BODY, signature: SIG }),
      }),
    );
    assert.equal(enq.status, 200);
    const afterEnqueue = await handleRequest(new Request(`http://127.0.0.1/api/pull/${PULL_PATH}`));
    assert.equal(afterEnqueue.status, 200);
    assert.equal(await afterEnqueue.text(), BODY);
  });
});

test("vercel function url is treated as the public pull path", async () => {
  await withPullSecret(async () => {
    await enqueueOnSecretPath();
    const viaHandler = await handleRequest(
      new Request(`http://127.0.0.1/api/pull/[secret].js?secret=${encodeURIComponent(PULL_PATH)}`),
    );
    assert.equal(viaHandler.status, 200);
    assert.equal(viaHandler.headers.get("x-signature"), SIG);
    assert.equal(await viaHandler.text(), BODY);

    await enqueueOnSecretPath();
    const viaNode = await invokeNode(pullSecretHandler, {
      method: "GET",
      url: "/api/pull/[secret].js",
      query: { secret: PULL_PATH },
    });
    assert.equal(viaNode.statusCode, 200);
    assert.equal(viaNode.headers["x-signature"], SIG);
    assert.equal(viaNode.body.toString(), BODY);

    await enqueueOnSecretPath();
    const viaQueryOnly = await invokeNode(pullSecretHandler, {
      method: "GET",
      url: "/?secret=" + encodeURIComponent(PULL_PATH),
      query: { secret: PULL_PATH },
    });
    assert.equal(viaQueryOnly.statusCode, 200);
    assert.equal(viaQueryOnly.body.toString(), BODY);

    const idle = await invokeNode(nodeHandler, {
      method: "GET",
      url: `/api/pull/${PULL_PATH}`,
    });
    assert.equal(idle.statusCode, 204);

    const root = await invokeNode(nodeHandler, { method: "GET", url: "/" });
    assert.equal(root.statusCode, 405);
    const rootQuery = await invokeNode(nodeHandler, {
      method: "GET",
      url: `/?secret=${encodeURIComponent(PULL_PATH)}`,
      query: { secret: PULL_PATH },
    });
    assert.equal(rootQuery.statusCode, 405);

    const put = await invokeNode(pullSecretHandler, {
      method: "PUT",
      url: "/api/pull/[secret].js",
      query: { secret: PULL_PATH },
      headers: {
        host: "127.0.0.1",
        authorization: `Bearer ${SECRET}`,
        "x-signature": SIG,
      },
      body: BODY,
    });
    assert.equal(put.statusCode, 200);
    const pulled = await invokeNode(pullSecretHandler, {
      method: "GET",
      url: "/?secret=" + encodeURIComponent(PULL_PATH),
      query: { secret: PULL_PATH },
    });
    assert.equal(pulled.statusCode, 200);
    assert.equal(pulled.headers["x-signature"], SIG);
    assert.equal(pulled.body.toString(), BODY);
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

test("local HTTP server secret path pulls and root does not", async () => {
  const port = 43179;
  const child = spawn(process.execPath, ["server.mjs"], {
    env: {
      ...process.env,
      PORT: String(port),
      QUEUE_SECRET: SECRET,
      PULL_PATH_SECRET: PULL_PATH,
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
    const exact = await fetch(`http://127.0.0.1:${port}/pull`);
    assert.equal(exact.status, 405);
    const pull = await fetch(`http://127.0.0.1:${port}/pull/${PULL_PATH}`);
    assert.equal(pull.status, 204);
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit").catch(() => {});
  }
});
