/* =========================================================
   RUBavu Today — CACHE LAYER (Redis-ready)

   Single lightweight cache abstraction used by all read-heavy
   public routes. Today it runs on an in-memory store so a single
   backend instance works with zero extra infrastructure. When the
   site is deployed behind a load balancer with more than one Node
   instance, enable Redis by:

     1. npm install ioredis
     2. export REDIS_URL=redis://user:pass@host:port

   No application code needs to change: getCache/setCache/deleteCache
   stay the same. The in-memory store is kept ONLY as a safe fallback
   when REDIS_URL is not configured or ioredis is unavailable.

   IMPORTANT (statelessness):
   - This cache only stores public read-model data (post lists, article
     details, categories, ads).
   - It NEVER stores authentication, sessions, or user-specific state.
   - It is therefore safe to run on many instances: each instance shares
     the same Redis or, without Redis, duplicates the same short-TTL
     public read cache (harmless, self-healing via TTL).
========================================================== */

const CACHE_ENABLED = String(
  process.env.CACHE_ENABLED ?? 'true'
).trim().toLowerCase() !== 'false';

let redis = null;
let memoryStore = null;

/* -------------------------------------------------------
   MENORY STORE (per-instance fallback)
------------------------------------------------------- */

function createMemoryStore() {
  const store = new Map();

  const sweep = () => {
    const now = Date.now();

    for (const [key, entry] of store) {
      if (entry.expiresAt <= now) {
        store.delete(key);
      }
    }
  };

  setInterval(sweep, 60 * 1000).unref();

  const memory = {
    async get(key) {
      const entry = store.get(key);

      if (!entry || entry.expiresAt <= Date.now()) {
        store.delete(key);
        return null;
      }

      return entry.value;
    },

    async set(key, value, ttlSeconds) {
      store.set(key, {
        value,
        expiresAt:
          Date.now() +
          Math.max(1, Number(ttlSeconds) || 1) * 1000,
      });
    },

    async delete(key) {
      store.delete(key);
    },

    async deleteByPrefix(prefix) {
      for (const key of store.keys()) {
        if (key.startsWith(prefix)) {
          store.delete(key);
        }
      }
    },

    async clear() {
      store.clear();
    },
  };

  return memory;
}

/* -------------------------------------------------------
   REDIS STORE (shared, production)
   Activated when REDIS_URL is set AND ioredis is installed.
------------------------------------------------------- */

function createRedisStore() {
  let Redis;

  try {
    Redis = require('ioredis');
  } catch (error) {
    console.warn(
      '[cache] REDIS_URL is set but "ioredis" is not installed. ' +
      'Falling back to in-memory cache. Run: npm install ioredis'
    );
    return null;
  }

  const client = new Redis(process.env.REDIS_URL, {
    lazyConnect: true,
    enableReadyCheck: true,
    maxRetriesPerRequest: 2,
    connectTimeout: 5000,
    retryStrategy(times) {
      return Math.min(times * 500, 5000);
    },
  });

  client.on('connect', () => {
    console.log('[cache] Redis connected.');
  });

  client.on('error', (error) => {
    console.error('[cache] Redis error:', error.message);
  });

  return {
    async get(key) {
      try {
        const raw = await client.get(key);

        return raw ? JSON.parse(raw) : null;
      } catch (error) {
        console.warn('[cache] Redis get failed:', error.message);
        return null;
      }
    },

    async set(key, value, ttlSeconds) {
      try {
        await client.set(
          key,
          JSON.stringify(value),
          'EX',
          Math.max(1, Number(ttlSeconds) || 1)
        );
      } catch (error) {
        console.warn('[cache] Redis set failed:', error.message);
      }
    },

    async delete(key) {
      try {
        await client.del(key);
      } catch (error) {
        console.warn('[cache] Redis delete failed:', error.message);
      }
    },

    async deleteByPrefix(prefix) {
      try {
        const stream = client.scanStream({
          match: `${prefix}*`,
          count: 100,
        });

        const keys = [];

        for await (const batch of stream) {
          keys.push(...batch);
        }

        if (keys.length) {
          await client.del(keys);
        }
      } catch (error) {
        console.warn('[cache] Redis deleteByPrefix failed:', error.message);
      }
    },

    async clear() {
      try {
        await client.flushdb();
      } catch (error) {
        console.warn('[cache] Redis flush failed:', error.message);
      }
    },

    async close() {
      try {
        const status = client.status;

        if (
          status !== 'connecting' &&
          status !== 'reconnecting' &&
          status !== 'ready'
        ) {
          client.disconnect();

          return;
        }

        await client.quit();
      } catch (error) {
        console.warn('[cache] Redis close failed:', error.message);
      }
    },
  };
}

/* -------------------------------------------------------
   SELECT BACKEND
------------------------------------------------------- */

function initCache() {
  if (!CACHE_ENABLED) {
    console.log('[cache] Cache disabled via CACHE_ENABLED=false.');
    return null;
  }

  if (process.env.REDIS_URL) {
    const store = createRedisStore();

    if (store) {
      redis = store;

      console.log('[cache] Using Redis cache (' + process.env.REDIS_URL.split('@').pop() + ').');
      return redis;
    }
  }

  memoryStore = createMemoryStore();

  console.log(
    '[cache] No REDIS_URL configured — using per-instance in-memory cache ' +
    '(safe for a single backend; add REDIS_URL + ioredis for multi-instance).'
  );

  return memoryStore;
}

const activeCache = initCache();

/* =========================================================
   PUBLIC API
========================================================== */

async function getCache(key) {
  if (!activeCache) return null;

  try {
    return await activeCache.get(String(key));
  } catch (error) {
    return null;
  }
}

async function setCache(key, value, ttlSeconds) {
  if (!activeCache || value === undefined || value === null) {
    return;
  }

  try {
    await activeCache.set(String(key), value, ttlSeconds);
  } catch {
    /* cache must never break the request */
  }
}

async function deleteCache(key) {
  if (!activeCache) return;

  try {
    await activeCache.delete(String(key));
  } catch {
    /* best effort */
  }
}

async function deleteCacheByPrefix(prefix) {
  if (!activeCache || !prefix) return;

  try {
    await activeCache.deleteByPrefix(String(prefix));
  } catch {
    /* best effort */
  }
}

async function clearCache() {
  if (!activeCache) return;

  try {
    await activeCache.clear();
  } catch {
    /* best effort */
  }
}

/* Stale-while-revalidate style helper:
   - returns cached value instantly if present,
   - otherwise runs loader, stores it, and returns it.
   Stale entries are served and refreshed in the background only
   when a lazyRefresher is supplied; otherwise the cache simply
   expires on TTL. */
async function withCache(key, ttlSeconds, loader, lazyRefresher) {
  const cached = await getCache(key);

  if (cached !== null && cached !== undefined) {
    return cached;
  }

  const fresh = await loader();

  await setCache(key, fresh, ttlSeconds);

  return fresh;
}

async function closeCache() {
  if (redis && typeof redis.close === 'function') {
    await redis.close();
  }
}

/* =========================================================
   CACHE INVALIDATION CONTEXT
   Post lifecycle / category / advertisement writes must call
   invalidateContentCaches() or invalidateCategories() /
   invalidateAdvertisements() so newly published content appears
   immediately instead of waiting for TTL expiry.
========================================================== */

async function invalidateContentCaches() {
  await Promise.all([
    deleteCacheByPrefix('pub:posts:list'),
    deleteCacheByPrefix('pub:post:id:'),
    deleteCacheByPrefix('pub:post:slug:'),
    deleteCacheByPrefix('pub:category:'),
    deleteCache('pub:categories'),
    deleteCache('pub:sitemap'),
  ]);
}

async function invalidateCategories() {
  await Promise.all([
    deleteCache('pub:categories'),
    deleteCacheByPrefix('pub:category:'),
    deleteCacheByPrefix('pub:posts:list'),
  ]);
}

async function invalidateAdvertisements() {
  await deleteCache('pub:ads');
}

async function invalidateRadioCaches() {
  await deleteCache('pub:radio');
}

module.exports = {
  getCache,
  setCache,
  deleteCache,
  deleteCacheByPrefix,
  clearCache,
  withCache,
  closeCache,
  invalidateContentCaches,
  invalidateCategories,
  invalidateAdvertisements,
  invalidateRadioCaches,
};