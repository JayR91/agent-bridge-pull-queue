// Production (main 71ebc6d) stores its one pending command in Vercel Runtime
// Cache via getCache() from @vercel/functions, plus this process's memory.
// The FIFO uses that same cache. Upstash is optional and is used only when
// both UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are set.

const FIFO_KEY = "agent-bridge:fifo";
const PULL_LOG_KEY = "agent-bridge:pull-log";
const TTL_SECONDS = 24 * 60 * 60;
const MAX_BATCH = 10;

const memory = globalThis.__agentBridgePullQueue ?? (globalThis.__agentBridgePullQueue = new Map());

function commandKey(id) {
  return `agent-bridge:cmd:${id}`;
}

function resultKey(id) {
  return `agent-bridge:result:${id}`;
}

function clone(value) {
  if (value == null) return null;
  return JSON.parse(JSON.stringify(value));
}

function clampLimit(limit) {
  const parsed = Number.parseInt(String(limit ?? "5"), 10);
  if (!Number.isFinite(parsed)) return 5;
  return Math.min(Math.max(parsed, 1), MAX_BATCH);
}

export function queueFromStore(store) {
  return {
    async enqueue({ body, signature, storedAtEpochMs }) {
      const id = crypto.randomUUID();
      const record = {
        id,
        body,
        signature,
        state: "pending",
        enqueuedAtEpochMs: storedAtEpochMs ?? Date.now(),
        pulledAtEpochMs: null,
      };
      await store.set(commandKey(id), record);
      const existing = await store.get(FIFO_KEY);
      const order = Array.isArray(existing) ? existing.slice() : [];
      order.push(id);
      await store.set(FIFO_KEY, order);
      return id;
    },
    async pull({ limit, device, now }) {
      const count = clampLimit(limit);
      const existing = await store.get(FIFO_KEY);
      const order = Array.isArray(existing) ? existing.slice() : [];
      const commands = [];
      const rest = [];
      for (const id of order) {
        if (commands.length >= count) {
          rest.push(id);
          continue;
        }
        const command = await store.get(commandKey(id));
        if (!command || command.state === "done") continue;
        command.state = "pulled";
        command.pulledAtEpochMs = now;
        await store.set(commandKey(id), command);
        commands.push({ id: command.id, body: command.body, signature: command.signature });
      }
      await store.set(FIFO_KEY, rest);
      await store.set(PULL_LOG_KEY, { lastPullEpochMs: now, device: device || null });
      return commands;
    },
    async getCommand(id) {
      return store.get(commandKey(id));
    },
    async saveResult(id, result) {
      const command = await store.get(commandKey(id));
      if (!command) return false;
      command.state = "done";
      await store.set(resultKey(id), result);
      await store.set(commandKey(id), command);
      const existing = await store.get(FIFO_KEY);
      const order = Array.isArray(existing) ? existing.filter((item) => item !== id) : [];
      await store.set(FIFO_KEY, order);
      return true;
    },
    async getResult(id) {
      return store.get(resultKey(id));
    },
    async getPullLog() {
      return store.get(PULL_LOG_KEY);
    },
  };
}

function memoryStore() {
  return {
    async get(key) {
      return memory.has(key) ? clone(memory.get(key)) : null;
    },
    async set(key, value) {
      memory.set(key, clone(value));
    },
    async delete(key) {
      memory.delete(key);
    },
  };
}

function runtimeStore(cache) {
  const local = memoryStore();
  return {
    async get(key) {
      try {
        const cached = await cache.get(key);
        if (cached != null) {
          await local.set(key, cached);
          return clone(cached);
        }
      } catch {
        // Runtime Cache is unavailable in this process. Memory still serves it.
      }
      return local.get(key);
    },
    async set(key, value) {
      await local.set(key, value);
      try {
        await cache.set(key, clone(value), { ttl: TTL_SECONDS, name: key });
      } catch {
        // The value remains in this instance. The next set retries the cache.
      }
    },
    async delete(key) {
      await local.delete(key);
      try {
        await cache.delete(key);
      } catch {
        // Memory already dropped it.
      }
    },
  };
}

const REDIS_FIFO_KEY = "ab:fifo";
const REDIS_PULL_LOG_KEY = "ab:pull-log";

function redisCommandKey(id) {
  return `ab:cmd:${id}`;
}

function redisResultKey(id) {
  return `ab:result:${id}`;
}

async function redisCommand(url, token, command, fetchImpl) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });
  const payload = await response.json();
  if (!response.ok || payload.error) {
    throw new Error(payload.error || `Redis HTTP ${response.status}`);
  }
  return payload.result;
}

const PULL_SCRIPT = `
local n = tonumber(ARGV[1])
local now = ARGV[2]
local ids = redis.call('LRANGE', KEYS[1], 0, n - 1)
if #ids > 0 then
  redis.call('LTRIM', KEYS[1], #ids, -1)
end
local out = {}
for _, id in ipairs(ids) do
  local raw = redis.call('GET', 'ab:cmd:' .. id)
  if raw then
    local cmd = cjson.decode(raw)
    if cmd.state ~= 'done' then
      cmd.state = 'pulled'
      cmd.pulledAtEpochMs = tonumber(now)
      redis.call('SET', 'ab:cmd:' .. id, cjson.encode(cmd), 'EX', ARGV[3])
      table.insert(out, cjson.encode({
        id = cmd.id,
        body = cmd.body,
        signature = cmd.signature
      }))
    end
  end
end
return out
`;

export function redisQueue(url, token, fetchImpl = fetch) {
  const call = (command) => redisCommand(url, token, command, fetchImpl);
  return {
    async enqueue({ body, signature, storedAtEpochMs }) {
      const id = crypto.randomUUID();
      const record = {
        id,
        body,
        signature,
        state: "pending",
        enqueuedAtEpochMs: storedAtEpochMs ?? Date.now(),
        pulledAtEpochMs: null,
      };
      await call(["SET", redisCommandKey(id), JSON.stringify(record), "EX", String(TTL_SECONDS)]);
      await call(["RPUSH", REDIS_FIFO_KEY, id]);
      return id;
    },
    async pull({ limit, device, now }) {
      const count = clampLimit(limit);
      const encoded = await call([
        "EVAL",
        PULL_SCRIPT,
        "1",
        REDIS_FIFO_KEY,
        String(count),
        String(now),
        String(TTL_SECONDS),
      ]);
      const commands = (Array.isArray(encoded) ? encoded : []).map((item) => JSON.parse(item));
      const log = { lastPullEpochMs: now, device: device || null };
      await call(["SET", REDIS_PULL_LOG_KEY, JSON.stringify(log), "EX", String(TTL_SECONDS)]);
      return commands;
    },
    async getCommand(id) {
      const raw = await call(["GET", redisCommandKey(id)]);
      return raw ? JSON.parse(raw) : null;
    },
    async saveResult(id, result) {
      const command = await this.getCommand(id);
      if (!command) return false;
      command.state = "done";
      await call(["SET", redisResultKey(id), JSON.stringify(result), "EX", String(TTL_SECONDS)]);
      await call(["SET", redisCommandKey(id), JSON.stringify(command), "EX", String(TTL_SECONDS)]);
      await call(["LREM", REDIS_FIFO_KEY, "0", id]);
      return true;
    },
    async getResult(id) {
      const raw = await call(["GET", redisResultKey(id)]);
      return raw ? JSON.parse(raw) : null;
    },
    async getPullLog() {
      const raw = await call(["GET", REDIS_PULL_LOG_KEY]);
      return raw ? JSON.parse(raw) : null;
    },
    async reset() {},
  };
}

let queuePromise;

async function openQueue() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return redisQueue(url, token);
  // Vercel sets VERCEL=1. That is the same signal main uses to reach Runtime Cache.
  if (process.env.VERCEL) {
    try {
      const { getCache } = await import("@vercel/functions");
      const cache = getCache();
      if (cache && typeof cache.get === "function" && typeof cache.set === "function") {
        return queueFromStore(runtimeStore(cache));
      }
    } catch {
      // Fall through to memory so a missing cache never becomes a 503.
    }
  }
  return queueFromStore(memoryStore());
}

export async function getQueue() {
  if (queuePromise) return queuePromise;
  queuePromise = Promise.resolve().then(() => openQueue());
  return queuePromise;
}

export async function resetQueueForTests() {
  queuePromise = null;
  memory.clear();
}
