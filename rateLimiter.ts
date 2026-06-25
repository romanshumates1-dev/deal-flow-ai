// src/middleware/rateLimiter.ts
import rateLimit from 'express-rate-limit';
import { redis } from '../utils/redis';
import { env } from '../config/env';

// Custom Redis store for rate limiter to support multi-instance deployments
class RedisStore {
  prefix: string;
  windowMs: number;

  constructor(opts: { prefix: string; windowMs: number }) {
    this.prefix = opts.prefix;
    this.windowMs = opts.windowMs;
  }

  async increment(key: string) {
    const redisKey = `${this.prefix}${key}`;
    const ttl = Math.ceil(this.windowMs / 1000);
    const current = await redis.incr(redisKey);
    if (current === 1) await redis.expire(redisKey, ttl);
    const resetTime = new Date(Date.now() + this.windowMs);
    return { totalHits: current, resetTime };
  }

  async decrement(key: string) {
    await redis.decr(`${this.prefix}${key}`);
  }

  async resetKey(key: string) {
    await redis.del(`${this.prefix}${key}`);
  }
}

// ─── General API rate limit (100 req/min per IP) ──────────────────────────
export const rateLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) =>
    (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
    req.socket.remoteAddress ||
    'unknown',
  handler: (_req, res) => {
    res.status(429).json({ error: 'Too many requests. Please slow down.', code: 'RATE_LIMITED' });
  },
  store: new RedisStore({ prefix: 'rl:api:', windowMs: env.RATE_LIMIT_WINDOW_MS }) as any,
});

// ─── Auth route rate limit (20 req/15min per IP — brute-force protection) ─
export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // only count failures
  handler: (_req, res) => {
    res.status(429).json({ error: 'Too many authentication attempts. Try again in 15 minutes.', code: 'AUTH_RATE_LIMITED' });
  },
  store: new RedisStore({ prefix: 'rl:auth:', windowMs: 15 * 60 * 1000 }) as any,
});

// ─── Webhook rate limit (200 req/min — Twilio sends status updates in bursts)
export const webhookRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).send(''); // Twilio expects an empty response, not JSON
  },
  store: new RedisStore({ prefix: 'rl:webhook:', windowMs: 60 * 1000 }) as any,
});
