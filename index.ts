// src/workers/index.ts
// ============================================================
// Worker entry point — runs in the "worker" Docker container.
// The API container does NOT run workers (RUN_WORKERS=false).
// This module imports the three worker files that already exist
// in the repo: aiWorker.ts, smsWorker.ts, followUpWorker.ts
// ============================================================

import './config/env'; // validate env first
import { env } from './config/env';
import { logger } from './utils/logger';
import { prisma } from './utils/prisma';
import { redis } from './utils/redis';

// Import existing worker files (preserved as-is from repo)
import { startAiWorker }      from './aiWorker';
import { startSmsWorker }     from './smsWorker';
import { startFollowUpWorker } from './followUpWorker';

// ─── Health check export for Docker healthcheck command ───
// Used by: node -e "require('./dist/workers/health').check()"
export async function check(): Promise<void> {
  await redis.ping();
  await prisma.$queryRaw`SELECT 1`;
  process.exit(0);
}

// ─── Startup ──────────────────────────────────────────────
async function startWorkerProcess() {
  logger.info('Worker container starting...');

  try {
    await prisma.$connect();
    logger.info('✅ Worker: Database connected');
  } catch (err) {
    logger.error({ err }, '❌ Worker: Database connection failed');
    process.exit(1);
  }

  try {
    await redis.ping();
    logger.info('✅ Worker: Redis connected');
  } catch (err) {
    logger.error({ err }, '❌ Worker: Redis connection failed');
    process.exit(1);
  }

  // Start all workers
  startAiWorker();
  startSmsWorker();
  startFollowUpWorker();

  logger.info('✅ All workers running');
}

// ─── Graceful shutdown ─────────────────────────────────────
async function shutdown(signal: string) {
  logger.info(`Worker received ${signal} — shutting down`);
  try {
    await prisma.$disconnect();
    await redis.quit();
    logger.info('Worker shutdown complete');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'Error during worker shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException',   (err)    => { logger.error({ err }, 'Worker uncaught exception'); process.exit(1); });
process.on('unhandledRejection',  (reason) => { logger.error({ reason }, 'Worker unhandled rejection'); process.exit(1); });

startWorkerProcess().catch(err => {
  logger.error({ err }, 'Worker failed to start');
  process.exit(1);
});
