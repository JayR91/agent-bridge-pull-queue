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
      if (!cache || typeof cache.get !== "function") return memoryStore();
      return {
        async read() {
          try {
            const cached = await cache.get(KEY);
            return cached ?? memory.item;
          } catch {
            return memory.item;
          }
        },
        async write(item) {
          memory.item = item;
          try {
            await cache.set(KEY, item, { ttl: TTL_SECONDS, name: "agent-bridge-pending" });
          } catch {
            // This instance still has the command if the runtime cache is unavailable.
          }
        },
        async clear() {
          memory.item = null;
          try {
            await cache.delete(KEY);
          } catch {
            // The in-process slot is already empty.
          }
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
