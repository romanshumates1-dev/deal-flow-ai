// src/utils/redis.ts
import { Redis } from 'ioredis';
import { logger } from './logger';

function createRedis(): Redis {
  const client = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false,
    retryStrategy: (times) => {
      if (times > 10) return null; // stop retrying after 10 attempts
      return Math.min(times * 200, 3000);
    },
  });

  client.on('connect', () => logger.debug('Redis connected'));
  client.on('ready',   () => logger.info('Redis ready'));
  client.on('error',   (err) => logger.error({ err }, 'Redis error'));
  client.on('close',   () => logger.warn('Redis connection closed'));
  client.on('reconnecting', () => logger.info('Redis reconnecting'));

  return client;
}

// Separate client for subscriptions (blocked while listening)
const globalForRedis = globalThis as unknown as {
  redis?: Redis;
  redisSub?: Redis;
};

export const redis    = globalForRedis.redis    ?? createRedis();
export const redisSub = globalForRedis.redisSub ?? createRedis();

if (process.env.NODE_ENV !== 'production') {
  globalForRedis.redis    = redis;
  globalForRedis.redisSub = redisSub;
}

// ─── Cache helpers ─────────────────────────────────────────────────────────

/** Get parsed JSON or null */
export async function cacheGet<T>(key: string): Promise<T | null> {
  const raw = await redis.get(key);
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

/** Set JSON with optional TTL in seconds */
export async function cacheSet(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
  const serialized = JSON.stringify(value);
  if (ttlSeconds) {
    await redis.set(key, serialized, 'EX', ttlSeconds);
  } else {
    await redis.set(key, serialized);
  }
}

/** Invalidate one key or a pattern (SCAN-based — safe for production) */
export async function cacheInvalidate(pattern: string): Promise<number> {
  if (!pattern.includes('*')) {
    return redis.del(pattern);
  }
  let cursor = '0';
  let deleted = 0;
  do {
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = nextCursor;
    if (keys.length) {
      deleted += await redis.del(...keys);
    }
  } while (cursor !== '0');
  return deleted;
}
