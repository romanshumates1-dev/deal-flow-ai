// src/workers/queues.ts
// All BullMQ queue instances — imported by routes (producers) and workers (consumers).

import { Queue } from 'bullmq';
import { redis } from '../utils/redis';

const connection = { host: redis.options.host, port: redis.options.port };

// ─── SMS Queue ─────────────────────────────────────────────────────────────
// Handles outbound SMS with Twilio rate limiting and retry logic.
export const smsQueue = new Queue('sms', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2_000 },
    removeOnComplete: { count: 5_000 },
    removeOnFail: { count: 1_000 },
  },
});

// ─── AI Queue ──────────────────────────────────────────────────────────────
// Handles all Claude API calls (intent classification, response generation).
// Kept separate so AI failures don't starve SMS sends.
export const aiQueue = new Queue('ai', {
  connection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: { count: 2_000 },
    removeOnFail: { count: 500 },
  },
});

// ─── Follow-Up Queue ───────────────────────────────────────────────────────
// Delayed jobs — BullMQ persists these in Redis across restarts.
export const followUpQueue = new Queue('follow-up', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 30_000 },
    removeOnComplete: { count: 10_000 },
    removeOnFail: { count: 1_000 },
  },
});

// ─── Contract Queue ────────────────────────────────────────────────────────
// PDF generation + DocuSign envelope creation.
export const contractQueue = new Queue('contract', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'fixed', delay: 10_000 },
    removeOnComplete: { count: 2_000 },
    removeOnFail: { count: 500 },
  },
});

// ─── Notification Queue ────────────────────────────────────────────────────
// In-app notifications and email alerts to team members.
export const notifQueue = new Queue('notification', {
  connection,
  defaultJobOptions: {
    attempts: 2,
    removeOnComplete: { count: 5_000 },
    removeOnFail: { count: 500 },
  },
});
