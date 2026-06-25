// src/middleware/errorHandler.ts
import { Request, Response, NextFunction } from 'express';
import { ApiError } from '../utils/errors';
import { logger } from '../utils/logger';
import { env } from '../config/env';
import { Prisma } from '@prisma/client';

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  const requestId = res.getHeader('X-Request-ID') as string | undefined;

  // ─── Known API error ───────────────────────────────────────────────────
  if (err instanceof ApiError) {
    if (err.statusCode >= 500) {
      logger.error({ err, requestId, path: req.path }, 'API error 5xx');
    } else {
      logger.warn({ statusCode: err.statusCode, code: err.code, path: req.path }, err.message);
    }

    res.status(err.statusCode).json({
      error: err.message,
      code: err.code,
      ...(err.details && { details: err.details }),
      ...(requestId && { requestId }),
    });
    return;
  }

  // ─── Prisma unique constraint ──────────────────────────────────────────
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      const fields = (err.meta?.target as string[])?.join(', ') || 'field';
      res.status(409).json({ error: `Duplicate value for ${fields}`, code: 'CONFLICT' });
      return;
    }
    if (err.code === 'P2025') {
      res.status(404).json({ error: 'Resource not found', code: 'NOT_FOUND' });
      return;
    }
    logger.error({ err, code: err.code, requestId }, 'Prisma error');
    res.status(500).json({ error: 'Database error', code: 'DB_ERROR' });
    return;
  }

  // ─── Validation errors from express-validator ──────────────────────────
  if ((err as any).type === 'entity.parse.failed') {
    res.status(400).json({ error: 'Invalid JSON body', code: 'PARSE_ERROR' });
    return;
  }

  // ─── Unknown error ─────────────────────────────────────────────────────
  logger.error({ err, requestId, path: req.path, method: req.method }, 'Unhandled error');

  res.status(500).json({
    error: env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
    code: 'INTERNAL',
    ...(requestId && { requestId }),
  });
}
