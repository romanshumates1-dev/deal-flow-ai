// src/routes/auth.ts
import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { authenticator } from 'otplib';
import { body, validationResult } from 'express-validator';
import { prisma } from '../utils/prisma';
import { redis } from '../utils/redis';
import { env } from '../config/env';
import { ApiError, asyncHandler } from '../utils/errors';
import { authenticate, AuthTokenPayload } from '../middleware/authenticate';
import { audit } from '../services/audit';
import { sendEmail } from '../services/email';
import { logger } from '../utils/logger';
import { UserRole } from '@prisma/client';

const router = Router();

const BCRYPT_ROUNDS = 12;
const ACCESS_TOKEN_EXPIRES = env.JWT_ACCESS_EXPIRES_IN;  // '15m'
const REFRESH_TOKEN_EXPIRES_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

// ─────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────

function issueAccessToken(payload: Omit<AuthTokenPayload, 'iat' | 'exp'>) {
  return jwt.sign(payload, env.JWT_SECRET, {
    expiresIn: ACCESS_TOKEN_EXPIRES,
  });
}

async function issueRefreshToken(
  userId: string,
  ip?: string,
  userAgent?: string
): Promise<string> {
  const rawToken = crypto.randomBytes(48).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRES_MS);

  await prisma.refreshToken.create({
    data: { userId, tokenHash, expiresAt, ip, userAgent },
  });

  return rawToken;
}

function getClientIp(req: Request): string {
  return (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
    || req.socket.remoteAddress
    || 'unknown';
}

// ─────────────────────────────────────────────────────────
// REGISTER
// ─────────────────────────────────────────────────────────

router.post('/register',
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 8 }).matches(/[A-Z]/).matches(/[0-9]/),
  body('firstName').isLength({ min: 1, max: 50 }).trim().escape(),
  body('lastName').isLength({ min: 1, max: 50 }).trim().escape(),
  body('organizationName').isLength({ min: 2, max: 100 }).trim(),
  asyncHandler(async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ApiError(400, 'Validation failed', 'VALIDATION_ERROR', errors.array());
    }

    const { email, password, firstName, lastName, organizationName } = req.body;

    // Check if email exists
    const existing = await prisma.user.findFirst({
      where: { email },
      select: { id: true },
    });
    if (existing) throw new ApiError(409, 'Email already registered');

    // Create organization slug
    const baseSlug = organizationName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    const slugExists = await prisma.organization.findUnique({ where: { slug: baseSlug } });
    const slug = slugExists ? `${baseSlug}-${Date.now()}` : baseSlug;

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const emailVerifyToken = crypto.randomBytes(32).toString('hex');

    const { user, org } = await prisma.$transaction(async (tx) => {
      const org = await tx.organization.create({
        data: { name: organizationName, slug },
      });
      const user = await tx.user.create({
        data: {
          organizationId: org.id,
          email,
          passwordHash,
          firstName,
          lastName,
          role: UserRole.ADMIN, // first user is admin
          emailVerifyToken,
        },
      });
      return { user, org };
    });

    // Send verification email (non-blocking)
    sendEmail({
      to: email,
      subject: 'Verify your DealFlow AI account',
      html: `<p>Hi ${firstName},</p>
             <p>Click below to verify your account:</p>
             <p><a href="${env.APP_URL}/verify-email?token=${emailVerifyToken}">Verify Email</a></p>`,
    }).catch(err => logger.warn({ err }, 'Failed to send verification email'));

    await audit.create({
      organizationId: org.id,
      userId: user.id,
      action: 'CREATED',
      entityType: 'user',
      entityId: user.id,
      after: { email, firstName, lastName, role: 'ADMIN' },
      ip: getClientIp(req),
    });

    res.status(201).json({
      message: 'Account created. Please verify your email.',
      userId: user.id,
    });
  })
);

// ─────────────────────────────────────────────────────────
// VERIFY EMAIL
// ─────────────────────────────────────────────────────────

router.post('/verify-email',
  body('token').isLength({ min: 64, max: 64 }).isHexadecimal(),
  asyncHandler(async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) throw new ApiError(400, 'Invalid token');

    const user = await prisma.user.findFirst({
      where: { emailVerifyToken: req.body.token },
      select: { id: true, organizationId: true, emailVerified: true },
    });

    if (!user) throw new ApiError(400, 'Invalid or expired verification token');
    if (user.emailVerified) {
      return res.json({ message: 'Email already verified' });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { emailVerified: true, emailVerifyToken: null },
    });

    res.json({ message: 'Email verified successfully' });
  })
);

// ─────────────────────────────────────────────────────────
// LOGIN
// ─────────────────────────────────────────────────────────

router.post('/login',
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
  asyncHandler(async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) throw new ApiError(400, 'Email and password required');

    const { email, password, mfaCode } = req.body;
    const ip = getClientIp(req);
    const ua = req.headers['user-agent'] || '';

    const user = await prisma.user.findFirst({
      where: { email },
      include: { organization: { select: { id: true, name: true, slug: true } } },
    });

    // Generic error message to prevent user enumeration
    const genericError = new ApiError(401, 'Invalid credentials');

    if (!user) throw genericError;

    // Check lockout
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const minutesLeft = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000);
      throw new ApiError(423, `Account locked. Try again in ${minutesLeft} minute(s).`);
    }

    // Verify password
    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      const attempts = user.failedLoginAttempts + 1;
      const lockUntil = attempts >= MAX_LOGIN_ATTEMPTS
        ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000)
        : null;

      await prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginAttempts: attempts,
          lockedUntil: lockUntil,
        },
      });

      throw genericError;
    }

    // Check email verified
    if (!user.emailVerified) {
      throw new ApiError(403, 'Please verify your email first', 'EMAIL_NOT_VERIFIED');
    }

    // MFA check
    if (user.mfaEnabled) {
      if (!mfaCode) {
        return res.status(200).json({ requiresMfa: true, message: 'MFA code required' });
      }

      const secret = user.mfaSecret ? decryptField(user.mfaSecretEnc!) : null;
      if (!secret || !authenticator.verify({ token: mfaCode, secret })) {
        // Check backup codes
        const validBackup = user.mfaBackupCodes?.find(code =>
          bcrypt.compareSync(mfaCode, code)
        );
        if (!validBackup) {
          throw new ApiError(401, 'Invalid MFA code');
        }
        // Consume backup code
        await prisma.user.update({
          where: { id: user.id },
          data: {
            mfaBackupCodes: user.mfaBackupCodes?.filter(c => c !== validBackup) || [],
          },
        });
      }
    }

    // Issue tokens
    const sessionId = crypto.randomUUID();
    const accessToken = issueAccessToken({
      sub: user.id,
      orgId: user.organizationId,
      role: user.role,
      sessionId,
    });
    const refreshToken = await issueRefreshToken(user.id, ip, ua);

    // Reset failed attempts, update last login
    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginAttempts: 0,
        lockedUntil: null,
        lastLoginAt: new Date(),
      },
    });

    await audit.create({
      organizationId: user.organizationId,
      userId: user.id,
      action: 'USER_LOGIN',
      entityType: 'user',
      entityId: user.id,
      ip,
      meta: { ua },
    });

    res.json({
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        mfaEnabled: user.mfaEnabled,
      },
      organization: {
        id: user.organization.id,
        name: user.organization.name,
        slug: user.organization.slug,
      },
    });
  })
);

// ─────────────────────────────────────────────────────────
// REFRESH TOKEN
// ─────────────────────────────────────────────────────────

router.post('/refresh',
  body('refreshToken').notEmpty(),
  asyncHandler(async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) throw new ApiError(400, 'refreshToken required');

    const rawToken: string = req.body.refreshToken;
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

    const record = await prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: { include: { organization: true } } },
    });

    if (!record) throw new ApiError(401, 'Invalid refresh token');
    if (record.revokedAt) throw new ApiError(401, 'Refresh token revoked');
    if (record.expiresAt < new Date()) throw new ApiError(401, 'Refresh token expired');

    const { user } = record;
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new ApiError(423, 'Account locked');
    }

    // Rotate: revoke old, issue new
    const ip = getClientIp(req);
    const ua = req.headers['user-agent'] || '';

    await prisma.refreshToken.update({
      where: { id: record.id },
      data: { revokedAt: new Date() },
    });

    const sessionId = crypto.randomUUID();
    const accessToken = issueAccessToken({
      sub: user.id,
      orgId: user.organizationId,
      role: user.role,
      sessionId,
    });
    const newRefreshToken = await issueRefreshToken(user.id, ip, ua);

    res.json({ accessToken, refreshToken: newRefreshToken });
  })
);

// ─────────────────────────────────────────────────────────
// LOGOUT
// ─────────────────────────────────────────────────────────

router.post('/logout',
  authenticate,
  body('refreshToken').optional().isString(),
  asyncHandler(async (req: Request, res: Response) => {
    if (req.body.refreshToken) {
      const tokenHash = crypto
        .createHash('sha256')
        .update(req.body.refreshToken)
        .digest('hex');
      await prisma.refreshToken.updateMany({
        where: { tokenHash, userId: req.user!.sub },
        data: { revokedAt: new Date() },
      });
    }

    // Add access token to Redis denylist until it expires
    const token = req.headers.authorization?.split(' ')[1];
    if (token) {
      const payload = jwt.decode(token) as { exp: number };
      if (payload?.exp) {
        const ttl = Math.max(0, payload.exp - Math.floor(Date.now() / 1000));
        await redis.set(`denylist:${token}`, '1', 'EX', ttl);
      }
    }

    await audit.create({
      organizationId: req.user!.orgId,
      userId: req.user!.sub,
      action: 'USER_LOGOUT',
      entityType: 'user',
      entityId: req.user!.sub,
      ip: getClientIp(req),
    });

    res.json({ message: 'Logged out' });
  })
);

// ─────────────────────────────────────────────────────────
// PASSWORD RESET REQUEST
// ─────────────────────────────────────────────────────────

router.post('/password-reset/request',
  body('email').isEmail().normalizeEmail(),
  asyncHandler(async (req: Request, res: Response) => {
    const { email } = req.body;

    // Always return success to prevent email enumeration
    const user = await prisma.user.findFirst({
      where: { email },
      select: { id: true, firstName: true, organizationId: true },
    });

    if (user) {
      const token = crypto.randomBytes(32).toString('hex');
      const expiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      await prisma.user.update({
        where: { id: user.id },
        data: { passwordResetToken: token, passwordResetExpiry: expiry },
      });

      sendEmail({
        to: email,
        subject: 'Reset your DealFlow AI password',
        html: `<p>Hi ${user.firstName},</p>
               <p>Click below to reset your password (expires in 1 hour):</p>
               <p><a href="${env.FRONTEND_URL}/reset-password?token=${token}">Reset Password</a></p>
               <p>If you didn't request this, ignore this email.</p>`,
      }).catch(err => logger.warn({ err }, 'Failed to send password reset email'));
    }

    res.json({ message: 'If that email exists, a reset link has been sent.' });
  })
);

// ─────────────────────────────────────────────────────────
// PASSWORD RESET CONFIRM
// ─────────────────────────────────────────────────────────

router.post('/password-reset/confirm',
  body('token').isLength({ min: 64, max: 64 }).isHexadecimal(),
  body('password').isLength({ min: 8 }).matches(/[A-Z]/).matches(/[0-9]/),
  asyncHandler(async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) throw new ApiError(400, 'Invalid token or password');

    const { token, password } = req.body;

    const user = await prisma.user.findFirst({
      where: {
        passwordResetToken: token,
        passwordResetExpiry: { gt: new Date() },
      },
      select: { id: true, organizationId: true },
    });

    if (!user) throw new ApiError(400, 'Invalid or expired reset token');

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: {
          passwordHash,
          passwordResetToken: null,
          passwordResetExpiry: null,
          failedLoginAttempts: 0,
          lockedUntil: null,
        },
      }),
      // Revoke all refresh tokens
      prisma.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);

    await audit.create({
      organizationId: user.organizationId,
      userId: user.id,
      action: 'SETTINGS_CHANGED',
      entityType: 'user',
      entityId: user.id,
      meta: { action: 'password_reset' },
      ip: getClientIp(req),
    });

    res.json({ message: 'Password reset successfully. Please log in.' });
  })
);

// ─────────────────────────────────────────────────────────
// MFA SETUP
// ─────────────────────────────────────────────────────────

router.post('/mfa/setup',
  authenticate,
  asyncHandler(async (req: Request, res: Response) => {
    const secret = authenticator.generateSecret();
    const user = await prisma.user.findUnique({
      where: { id: req.user!.sub },
      select: { email: true, mfaEnabled: true },
    });
    if (!user) throw new ApiError(404, 'User not found');
    if (user.mfaEnabled) throw new ApiError(409, 'MFA already enabled');

    // Store encrypted secret temporarily in Redis until confirmed
    await redis.set(`mfa:setup:${req.user!.sub}`, secret, 'EX', 600); // 10 min

    const otpAuthUrl = authenticator.keyuri(user.email, 'DealFlow AI', secret);

    res.json({
      secret,
      otpAuthUrl,
      instructions: 'Scan the QR code or enter the secret in your authenticator app, then confirm with /mfa/confirm',
    });
  })
);

router.post('/mfa/confirm',
  authenticate,
  body('code').isLength({ min: 6, max: 6 }).isNumeric(),
  asyncHandler(async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) throw new ApiError(400, 'Invalid MFA code format');

    const secret = await redis.get(`mfa:setup:${req.user!.sub}`);
    if (!secret) throw new ApiError(400, 'MFA setup session expired. Start over.');

    if (!authenticator.verify({ token: req.body.code, secret })) {
      throw new ApiError(400, 'Invalid MFA code');
    }

    // Generate backup codes
    const backupCodes = Array.from({ length: 8 }, () =>
      crypto.randomBytes(4).toString('hex').toUpperCase()
    );
    const hashedCodes = await Promise.all(
      backupCodes.map(code => bcrypt.hash(code, 10))
    );

    await prisma.user.update({
      where: { id: req.user!.sub },
      data: {
        mfaEnabled: true,
        mfaSecretEnc: encryptField(secret),
        mfaBackupCodes: hashedCodes,
      },
    });

    await redis.del(`mfa:setup:${req.user!.sub}`);

    res.json({
      message: 'MFA enabled',
      backupCodes, // Show only once — user must save these
    });
  })
);

router.delete('/mfa',
  authenticate,
  body('code').isLength({ min: 6, max: 6 }).isNumeric(),
  asyncHandler(async (req: Request, res: Response) => {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.sub },
      select: { mfaEnabled: true, mfaSecretEnc: true },
    });
    if (!user?.mfaEnabled) throw new ApiError(409, 'MFA not enabled');

    const secret = decryptField(user.mfaSecretEnc!);
    if (!authenticator.verify({ token: req.body.code, secret })) {
      throw new ApiError(400, 'Invalid MFA code');
    }

    await prisma.user.update({
      where: { id: req.user!.sub },
      data: { mfaEnabled: false, mfaSecretEnc: null, mfaBackupCodes: [] },
    });

    res.json({ message: 'MFA disabled' });
  })
);

// ─── Stub encryption helpers (use utils/crypto.ts in production) ───
function encryptField(plaintext: string): string {
  const { encrypt } = require('../utils/crypto');
  return encrypt(plaintext);
}

function decryptField(ciphertext: string): string {
  const { decrypt } = require('../utils/crypto');
  return decrypt(ciphertext);
}

export default router;
