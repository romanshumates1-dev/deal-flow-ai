// src/middleware/organizationContext.ts
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { prisma } from '../utils/prisma';
import { redis } from '../utils/redis';
import { ApiError } from '../utils/errors';
import { AuthTokenPayload } from './authenticate';

/**
 * Authenticates the Bearer token, checks the Redis denylist,
 * verifies org membership and account lock status, then attaches
 * req.user and req.organizationId for downstream handlers.
 *
 * Applied to all /api/* routes except /api/auth and /api/webhooks.
 */
export async function organizationContext(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) throw new ApiError(401, 'Authentication required');

    const token = auth.split(' ')[1];

    // ─── Check token denylist (logout / password reset) ───────────────
    const denied = await redis.get(`denylist:${token}`);
    if (denied) throw new ApiError(401, 'Token has been revoked', 'TOKEN_REVOKED');

    // ─── Verify JWT ───────────────────────────────────────────────────
    let payload: AuthTokenPayload;
    try {
      payload = jwt.verify(token, env.JWT_SECRET) as AuthTokenPayload;
    } catch (err) {
      if (err instanceof jwt.TokenExpiredError) {
        throw new ApiError(401, 'Token expired — please refresh', 'TOKEN_EXPIRED');
      }
      throw new ApiError(401, 'Invalid token', 'INVALID_TOKEN');
    }

    // ─── Verify user still exists and org membership ──────────────────
    const user = await prisma.user.findFirst({
      where: { id: payload.sub, organizationId: payload.orgId },
      select: { id: true, role: true, lockedUntil: true, emailVerified: true },
    });

    if (!user) throw new ApiError(403, 'Account not found or access revoked');
    if (!user.emailVerified) throw new ApiError(403, 'Email not verified', 'EMAIL_NOT_VERIFIED');
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new ApiError(423, 'Account temporarily locked');
    }

    req.user = { ...payload, role: user.role }; // use DB role (in case it changed)
    req.organizationId = payload.orgId;

    next();
  } catch (err) {
    next(err);
  }
}
