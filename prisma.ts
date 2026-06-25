// src/utils/prisma.ts
import { PrismaClient } from '@prisma/client';
import { logger } from './logger';

// Singleton to prevent connection pool exhaustion in hot-reload environments
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: [
      { emit: 'event', level: 'query' },
      { emit: 'event', level: 'error' },
      { emit: 'event', level: 'warn' },
    ],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;

  // Log slow queries in development
  (prisma as any).$on('query', (e: any) => {
    if (e.duration > 200) {
      logger.warn({ query: e.query, duration: `${e.duration}ms` }, 'Slow DB query');
    }
  });
}

(prisma as any).$on('error', (e: any) => {
  logger.error({ err: e }, 'Prisma error');
});
