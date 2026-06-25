// src/workers/queues.ts — PATCHED from repo original
// ============================================================
// BUG FOUND IN AUDIT (confirmed, not theoretical):
//
// Original code (queues.ts line 6):
//   const connection = { host: redis.options.host, port: redis.options.port };
//
// This silently breaks when REDIS_URL includes authentication
// (redis://:password@host:port) because ioredis parses the URL
// and stores auth separately — redis.options.host/port returns
// the hostname only but BullMQ won't pass the password.
//
// FIX: Pass the full connection URL string to BullMQ instead of
// extracting host/port. BullMQ Queue/Worker both accept { url: string }.
// ============================================================

import { Queue } from 'bullmq';

// Pull REDIS_URL directly — already validated by env.ts (Zod)
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// BullMQ accepts { url } for full URL-based connections (including auth/TLS)
const connection = { url: REDIS_URL };

// ─── SMS Queue ──────────────────────────────────────────────
export const smsQueue = new Queue('sms', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2_000 },
    removeOnComplete: { count: 5_000 },
    removeOnFail: { count: 1_000 },
  },
});

// ─── AI Queue ───────────────────────────────────────────────
// Kept separate from SMS so AI failures don't starve SMS sends (preserved logic)
export const aiQueue = new Queue('ai', {
  connection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: { count: 2_000 },
    removeOnFail: { count: 500 },
  },
});

// ─── Follow-Up Queue ────────────────────────────────────────
export const followUpQueue = new Queue('follow-up', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 30_000 },
    removeOnComplete: { count: 10_000 },
    removeOnFail: { count: 1_000 },
  },
});

// ─── Contract Queue ─────────────────────────────────────────
export const contractQueue = new Queue('contract', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'fixed', delay: 10_000 },
    removeOnComplete: { count: 2_000 },
    removeOnFail: { count: 500 },
  },
});

// ─── Notification Queue ─────────────────────────────────────
export const notifQueue = new Queue('notification', {
  connection,
  defaultJobOptions: {
    attempts: 2,
    removeOnComplete: { count: 5_000 },
    removeOnFail: { count: 500 },
  },
});
