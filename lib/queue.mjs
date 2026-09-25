const FIFO_KEY = "ab:fifo";
const PULL_LOG_KEY = "ab:pull-log";
const TTL_SECONDS = 24 * 60 * 60;
const MAX_BATCH = 10;

const memory = globalThis.__agentBridgePullQueue ??
  (globalThis.__agentBridgePullQueue = {
    order: [],
    commands: new Map(),
    results: new Map(),
    pullLog: null,
  });

export class StorageUnavailable extends Error {
  constructor() {
    super(
      "UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are not set. Connect Upstash Redis from the Vercel Marketplace to this project, then redeploy.",
    );
    this.status = 503;
  }
}

function clampLimit(limit) {
  const parsed = Number.parseInt(String(limit ?? "5"), 10);
  if (!Number.isFinite(parsed)) return 5;
  return Math.min(Math.max(parsed, 1), MAX_BATCH);
}

function commandKey(id) {
  return `ab:cmd:${id}`;
}

function resultKey(id) {
  return `ab:result:${id}`;
}

function memoryQueue() {
  return {
    async enqueue({ body, signature, storedAtEpochMs }) {
      const id = crypto.randomUUID();
      memory.commands.set(id, {
        id,
        body,
        signature,
        state: "pending",
        enqueuedAtEpochMs: storedAtEpochMs ?? Date.now(),
        pulledAtEpochMs: null,
      });
      memory.order.push(id);
      return id;
    },
    async pull({ limit, device, now }) {
      const count = clampLimit(limit);
      const commands = [];
      while (commands.length < count && memory.order.length > 0) {
        const id = memory.order.shift();
        const command = memory.commands.get(id);
        if (!command || command.state === "done") continue;
        command.state = "pulled";
        command.pulledAtEpochMs = now;
        commands.push({ id: command.id, body: command.body, signature: command.signature });
      }
      memory.pullLog = { lastPullEpochMs: now, device: device || null };
      return commands;
    },
    async getCommand(id) {
      return memory.commands.get(id) ?? null;
    },
    async saveResult(id, result) {
      const command = memory.commands.get(id);
      if (!command) return false;
      memory.results.set(id, result);
      command.state = "done";
      memory.order = memory.order.filter((item) => item !== id);
      return true;
    },
    async getResult(id) {
      return memory.results.get(id) ?? null;
    },
    async getPullLog() {
      return memory.pullLog;
    },
    async reset() {
      memory.order = [];
      memory.commands = new Map();
      memory.results = new Map();
      memory.pullLog = null;
    },
  };
}

function unavailableQueue() {
  const fail = async () => {
    throw new StorageUnavailable();
  };
  return {
    enqueue: fail,
    pull: fail,
    getCommand: fail,
    saveResult: fail,
    getResult: fail,
    getPullLog: fail,
    reset: async () => {},
  };
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
      await call(["SET", commandKey(id), JSON.stringify(record), "EX", String(TTL_SECONDS)]);
      await call(["RPUSH", FIFO_KEY, id]);
      return id;
    },
    async pull({ limit, device, now }) {
      const count = clampLimit(limit);
      const encoded = await call([
        "EVAL",
        PULL_SCRIPT,
        "1",
        FIFO_KEY,
        String(count),
        String(now),
        String(TTL_SECONDS),
      ]);
      const commands = (Array.isArray(encoded) ? encoded : []).map((item) => JSON.parse(item));
      const log = { lastPullEpochMs: now, device: device || null };
      await call(["SET", PULL_LOG_KEY, JSON.stringify(log), "EX", String(TTL_SECONDS)]);
      return commands;
    },
    async getCommand(id) {
      const raw = await call(["GET", commandKey(id)]);
      return raw ? JSON.parse(raw) : null;
    },
    async saveResult(id, result) {
      const command = await this.getCommand(id);
      if (!command) return false;
      command.state = "done";
      await call(["SET", resultKey(id), JSON.stringify(result), "EX", String(TTL_SECONDS)]);
      await call(["SET", commandKey(id), JSON.stringify(command), "EX", String(TTL_SECONDS)]);
      await call(["LREM", FIFO_KEY, "0", id]);
      return true;
    },
    async getResult(id) {
      const raw = await call(["GET", resultKey(id)]);
      return raw ? JSON.parse(raw) : null;
    },
    async getPullLog() {
      const raw = await call(["GET", PULL_LOG_KEY]);
      return raw ? JSON.parse(raw) : null;
    },
    async reset() {},
  };
}

let queuePromise;

export async function getQueue() {
  if (queuePromise) return queuePromise;
  queuePromise = Promise.resolve().then(() => {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (url && token) return redisQueue(url, token);
    if (process.env.VERCEL) return unavailableQueue();
    return memoryQueue();
  });
  return queuePromise;
}

export async function resetQueueForTests() {
  queuePromise = null;
  const queue = memoryQueue();
  await queue.reset();
}
