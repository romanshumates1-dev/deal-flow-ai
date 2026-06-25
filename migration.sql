-- ============================================================
-- Migration: 20250625000002_add_performance_indexes
-- Additional indexes for production query patterns.
--
-- These supplement the Prisma-defined indexes in schema.prisma
-- and target the most common access patterns observed in the
-- route code (sellers, buyers, messages, followups, audit).
-- ============================================================

-- ─── SellerLead: dashboard "active leads" query ──────────
-- Used by: GET /api/sellers?status=WARM&organizationId=...
CREATE INDEX CONCURRENTLY IF NOT EXISTS "SellerLead_org_status_createdAt_idx"
  ON "SellerLead"("organizationId", "status", "createdAt" DESC);

-- ─── SellerLead: "opted-out" compliance filter ───────────
CREATE INDEX CONCURRENTLY IF NOT EXISTS "SellerLead_optedOutAt_idx"
  ON "SellerLead"("optedOutAt")
  WHERE "optedOutAt" IS NOT NULL;

-- ─── SellerLead: AI paused filter ────────────────────────
CREATE INDEX CONCURRENTLY IF NOT EXISTS "SellerLead_aiPaused_idx"
  ON "SellerLead"("organizationId", "aiPaused")
  WHERE "aiPaused" = true;

-- ─── BuyerLead: same patterns as seller ──────────────────
CREATE INDEX CONCURRENTLY IF NOT EXISTS "BuyerLead_org_status_createdAt_idx"
  ON "BuyerLead"("organizationId", "status", "createdAt" DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "BuyerLead_optedOutAt_idx"
  ON "BuyerLead"("optedOutAt")
  WHERE "optedOutAt" IS NOT NULL;

-- ─── Message: conversation thread load ───────────────────
-- Used by: GET /api/messages?sellerId=... ORDER BY createdAt
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Message_sellerId_createdAt_idx"
  ON "Message"("sellerId", "createdAt" ASC)
  WHERE "sellerId" IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Message_buyerId_createdAt_idx"
  ON "Message"("buyerId", "createdAt" ASC)
  WHERE "buyerId" IS NOT NULL;

-- ─── FollowUp: worker poll (most critical) ───────────────
-- The followUpWorker polls for: status=SCHEDULED AND scheduledFor <= now()
-- This index makes that scan O(log n) instead of O(n).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "FollowUp_worker_poll_idx"
  ON "FollowUp"("scheduledFor", "status")
  WHERE "status" = 'SCHEDULED';

-- ─── RefreshToken: cleanup of expired tokens ─────────────
CREATE INDEX CONCURRENTLY IF NOT EXISTS "RefreshToken_expiresAt_idx"
  ON "RefreshToken"("expiresAt")
  WHERE "revokedAt" IS NULL;

-- ─── AuditLog: recent activity feed (DESC sort) ──────────
CREATE INDEX CONCURRENTLY IF NOT EXISTS "AuditLog_org_createdAt_idx"
  ON "AuditLog"("organizationId", "createdAt" DESC);

-- ─── Notification: unread count badge ────────────────────
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Notification_org_unread_idx"
  ON "Notification"("organizationId", "createdAt" DESC)
  WHERE "readAt" IS NULL AND "dismissedAt" IS NULL;

-- ─── Task: overdue task alert ────────────────────────────
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Task_org_overdue_idx"
  ON "Task"("organizationId", "dueAt")
  WHERE "status" IN ('OPEN', 'IN_PROGRESS') AND "dueAt" IS NOT NULL;

-- ─── Campaign: active campaigns per org ──────────────────
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Campaign_org_active_idx"
  ON "Campaign"("organizationId")
  WHERE "isActive" = true;

-- ─── Trigram indexes for name search (requires pg_trgm) ──
-- These enable fast ILIKE '%search_term%' on lead name fields.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "SellerLead_name_trgm_idx"
  ON "SellerLead" USING GIN ("name" gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "BuyerLead_name_trgm_idx"
  ON "BuyerLead" USING GIN ("name" gin_trgm_ops);
