// src/services/audit.ts
import { AuditAction } from '@prisma/client';
import { prisma } from '../utils/prisma';
import { logger } from '../utils/logger';

interface AuditEntry {
  organizationId: string;
  userId?: string | null;
  action: AuditAction;
  entityType: string;
  entityId: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  ip?: string | null;
  userAgent?: string | null;
  meta?: Record<string, unknown> | null;
}

/** Fire-and-forget audit log — never throws, never blocks the request */
async function create(entry: AuditEntry): Promise<void> {
  try {
    await prisma.auditLog.create({ data: entry });
  } catch (err) {
    // Audit failures must not break business logic
    logger.error({ err, entry }, 'Failed to write audit log');
  }
}

/** Create multiple audit entries in one transaction */
async function createMany(entries: AuditEntry[]): Promise<void> {
  try {
    await prisma.auditLog.createMany({ data: entries });
  } catch (err) {
    logger.error({ err }, 'Failed to write audit logs (bulk)');
  }
}

export const audit = { create, createMany };
