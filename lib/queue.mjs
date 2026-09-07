const KEY = "agent-bridge:pending-command";
const TTL_SECONDS = 10 * 60;

const memory = globalThis.__agentBridgePullQueue ?? (globalThis.__agentBridgePullQueue = { item: null });

function memoryStore() {
  return {
    async read() {
      return memory.item;
    },
    async write(item) {
      memory.item = item;
    },
    async clear() {
      memory.item = null;
    },
  };
}

let runtimeStorePromise;

async function runtimeStore() {
  if (runtimeStorePromise !== undefined) return runtimeStorePromise;
  runtimeStorePromise = (async () => {
    try {
      const { getCache } = await import("@vercel/functions");
      const cache = getCache();
      return {
        async read() {
          const cached = await cache.get(KEY);
          return cached ?? memory.item;
        },
        async write(item) {
          memory.item = item;
          await cache.set(KEY, item, { ttl: TTL_SECONDS, name: "agent-bridge-pending" });
        },
        async clear() {
          memory.item = null;
          await cache.delete(KEY);
        },
      };
    } catch {
      return memoryStore();
    }
  })();
  return runtimeStorePromise;
}

export async function getQueue() {
  return runtimeStore();
}
