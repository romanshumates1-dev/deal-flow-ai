// src/routes/health.ts
import { Router, Request, Response } from 'express';
import { prisma } from '../utils/prisma';
import { redis } from '../utils/redis';
import { smsQueue, aiQueue, followUpQueue } from '../workers/queues';

const router = Router();

router.get('/', async (_req: Request, res: Response) => {
  const checks: Record<string, string> = {};
  let overallOk = true;

  // Database
  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = 'ok';
  } catch {
    checks.database = 'error';
    overallOk = false;
  }

  // Redis
  try {
    const pong = await redis.ping();
    checks.redis = pong === 'PONG' ? 'ok' : 'error';
    if (checks.redis !== 'ok') overallOk = false;
  } catch {
    checks.redis = 'error';
    overallOk = false;
  }

  // Queues
  try {
    const [smsCounts, aiCounts, followUpCounts] = await Promise.all([
      smsQueue.getJobCounts(),
      aiQueue.getJobCounts(),
      followUpQueue.getJobCounts(),
    ]);
    checks.queues = 'ok';
    checks.smsFailed    = String(smsCounts.failed    || 0);
    checks.aiFailed     = String(aiCounts.failed     || 0);
    checks.followUpDelayed = String(followUpCounts.delayed || 0);
  } catch {
    checks.queues = 'error';
  }

  res.status(overallOk ? 200 : 503).json({
    status: overallOk ? 'healthy' : 'degraded',
    version: '3.0.0',
    timestamp: new Date().toISOString(),
    checks,
  });
});

// Lightweight liveness probe (no DB check — for Kubernetes)
router.get('/live', (_req, res) => {
  res.status(200).json({ status: 'alive' });
});

export default router;
