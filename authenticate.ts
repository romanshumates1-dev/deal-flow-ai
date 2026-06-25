// src/middleware/authenticate.ts
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { prisma } from '../utils/prisma';
import { ApiError } from '../utils/errors';
import { UserRole } from '@prisma/client';

export interface AuthTokenPayload {
  sub: string;         // userId
  orgId: string;       // organizationId
  role: UserRole;
  sessionId: string;   // for token invalidation
  iat: number;
  exp: number;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthTokenPayload;
      organizationId?: string;
    }
  }
}

// ─── Extract token from Authorization header ───
function extractToken(req: Request): string | null {
  const auth = req.headers.authorization;
  if (!auth) return null;
  const [scheme, token] = auth.split(' ');
  if (scheme !== 'Bearer' || !token) return null;
  return token;
}

// ─── Core auth middleware ───
export function authenticate(req: Request, res: Response, next: NextFunction) {
  const token = extractToken(req);
  if (!token) throw new ApiError(401, 'Authentication required');

  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as AuthTokenPayload;
    req.user = payload;
    req.organizationId = payload.orgId;
    next();
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      throw new ApiError(401, 'Token expired', 'TOKEN_EXPIRED');
    }
    if (err instanceof jwt.JsonWebTokenError) {
      throw new ApiError(401, 'Invalid token', 'INVALID_TOKEN');
    }
    throw err;
  }
}

// ─── Role-based access control ───
export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) throw new ApiError(401, 'Authentication required');
    if (!roles.includes(req.user.role)) {
      throw new ApiError(403, `Requires one of: ${roles.join(', ')}`);
    }
    next();
  };
}

// ─── Shorthand role guards ───
export const requireAdmin = requireRole(UserRole.ADMIN);
export const requireManager = requireRole(
  UserRole.ADMIN,
  UserRole.ACQUISITION_MANAGER,
  UserRole.DISPOSITION_MANAGER
);
export const requireAcquisition = requireRole(
  UserRole.ADMIN,
  UserRole.ACQUISITION_MANAGER
);
export const requireDisposition = requireRole(
  UserRole.ADMIN,
  UserRole.DISPOSITION_MANAGER
);
export const requireAny = requireRole(
  UserRole.ADMIN,
  UserRole.ACQUISITION_MANAGER,
  UserRole.DISPOSITION_MANAGER,
  UserRole.VIRTUAL_ASSISTANT
);

// ─── Verify org membership ───
export async function verifyOrgMembership(
  req: Request,
  res: Response,
  next: NextFunction
) {
  if (!req.user) throw new ApiError(401, 'Authentication required');

  const user = await prisma.user.findFirst({
    where: {
      id: req.user.sub,
      organizationId: req.user.orgId,
    },
    select: { id: true, role: true, lockedUntil: true },
  });

  if (!user) throw new ApiError(403, 'Access denied');

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw new ApiError(423, 'Account temporarily locked');
  }

  next();
}
