// src/routes/webhooks.ts
// Handles Twilio inbound SMS and delivery status callbacks.
// Must respond within 15 seconds — all heavy work is queued.

import { Router, Request, Response } from 'express';
import express from 'express';
import { prisma } from '../utils/prisma';
import { aiQueue } from '../workers/queues';
import { verifyTwilioSignature } from '../services/sms';
import { normalizePhone, isOptOutKeyword } from '../utils/phone';
import { logger } from '../utils/logger';
import { SellerStatus, BuyerStatus, ConsentStatus } from '@prisma/client';
import { audit } from '../services/audit';
import { env } from '../config/env';

const router = Router();

// Twilio sends URL-encoded POST — needs raw body for signature verification
router.use(express.urlencoded({ extended: false }));

// ─── Inbound SMS + delivery status ───────────────────────────────────────

router.post('/twilio', async (req: Request, res: Response): Promise<void> => {
  // Always respond immediately — Twilio has a 15s timeout
  res.type('text/xml').send('<Response></Response>');

  const body      = (req.body.Body         || '').trim();
  const from      = (req.body.From         || '').trim();
  const msgStatus = (req.body.MessageStatus || '').trim();
  const smsSid    = (req.body.SmsSid || req.body.MessageSid || '').trim();
  const orgSlug   = (req.query.org as string) || '';

  // ─── Delivery status callback (no body) ───────────────────────────
  if (msgStatus && !body) {
    if (smsSid) {
      const delivered = msgStatus === 'delivered';
      const failed    = msgStatus === 'failed' || msgStatus === 'undelivered';

      await prisma.message.updateMany({
        where: { smsSid },
        data: { smsStatus: msgStatus },
      });

      if (delivered || failed) {
        const orgId = await getOrgIdFromSid(smsSid);
        if (orgId) {
          await prisma.smsStats.upsert({
            where: { organizationId: orgId },
            create: { organizationId: orgId, delivered: delivered ? 1 : 0, failed: failed ? 1 : 0 },
            update: { delivered: delivered ? { increment: 1 } : undefined, failed: failed ? { increment: 1 } : undefined },
          });
        }
      }
    }
    return;
  }

  if (!from || !body) return;

  const normFrom = normalizePhone(from);
  if (!normFrom) {
    logger.warn({ from }, 'Could not normalize inbound phone number');
    return;
  }

  logger.info({ from: normFrom, body: body.slice(0, 80) }, 'Inbound SMS');

  // ─── Find the organization via slug or Twilio number ──────────────
  let org = orgSlug
    ? await prisma.organization.findUnique({
        where: { slug: orgSlug },
        select: { id: true, twilioSid: true, twilioToken: true, twilioFrom: true },
      })
    : await prisma.organization.findFirst({
        where: { twilioFrom: normFrom },
        select: { id: true, twilioSid: true, twilioToken: true, twilioFrom: true },
      });

  if (!org) {
    // Fallback: find any org that has a lead with this number
    const seller = await prisma.sellerLead.findFirst({ where: { phone: normFrom }, select: { organizationId: true } });
    const buyer  = seller ? null : await prisma.buyerLead.findFirst({ where: { phone: normFrom }, select: { organizationId: true } });
    const orgId  = seller?.organizationId || buyer?.organizationId;
    if (!orgId) { logger.warn({ from: normFrom }, 'Webhook: unknown number, no org found'); return; }
    org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { id: true, twilioSid: true, twilioToken: true, twilioFrom: true },
    });
  }

  if (!org) return;

  // ─── Signature verification ────────────────────────────────────────
  const signature = req.headers['x-twilio-signature'] as string || '';
  const webhookUrl = `${env.APP_URL}/api/webhooks/twilio${orgSlug ? '?org=' + orgSlug : ''}`;
  const valid = verifyTwilioSignature(
    { accountSid: org.twilioSid, authToken: org.twilioToken },
    webhookUrl,
    req.body,
    signature
  );
  if (!valid) {
    logger.error({ from: normFrom }, 'Invalid Twilio signature — rejecting webhook');
    return;
  }

  // ─── TCPA opt-out — MUST be handled first, always ─────────────────
  if (isOptOutKeyword(body)) {
    await handleOptOut(org.id, normFrom, body);
    return;
  }

  // ─── Duplicate prevention (idempotency via SmsSid) ────────────────
  if (smsSid) {
    const existing = await prisma.message.findFirst({ where: { smsSid }, select: { id: true } });
    if (existing) {
      logger.warn({ smsSid }, 'Duplicate inbound message — skipping');
      return;
    }
  }

  // ─── Find lead ─────────────────────────────────────────────────────
  const [seller, buyer] = await Promise.all([
    prisma.sellerLead.findFirst({
      where: { phone: normFrom, organizationId: org.id },
      select: { id: true, status: true, aiPaused: true },
    }),
    prisma.buyerLead.findFirst({
      where: { phone: normFrom, organizationId: org.id },
      select: { id: true, status: true, aiPaused: true },
    }),
  ]);

  if (!seller && !buyer) {
    logger.warn({ from: normFrom, orgId: org.id }, 'Inbound SMS from unknown lead');
    return;
  }

  const sellerId = seller?.id;
  const buyerId  = buyer?.id;

  // ─── Persist inbound message ───────────────────────────────────────
  const inboundMsg = await prisma.message.create({
    data: {
      organizationId: org.id,
      sellerId:  sellerId || null,
      buyerId:   buyerId  || null,
      role:      'PROSPECT',
      channel:   'SMS',
      content:   body,
      smsSid:    smsSid || null,
      smsStatus: 'received',
    },
  });

  await prisma.smsStats.upsert({
    where:  { organizationId: org.id },
    create: { organizationId: org.id, received: 1 },
    update: { received: { increment: 1 } },
  });

  // ─── Route to AI worker (non-blocking) ────────────────────────────
  const lead = seller || buyer!;
  if (lead.status === (seller ? SellerStatus.DO_NOT_CONTACT : BuyerStatus.DO_NOT_CONTACT)) {
    logger.warn({ from: normFrom }, 'Inbound from opted-out contact — ignoring');
    return;
  }

  if (!lead.aiPaused) {
    await aiQueue.add('process-inbound', {
      organizationId:   org.id,
      inboundMessageId: inboundMsg.id,
      sellerId,
      buyerId,
      inboundText: body,
    }, { priority: 1 });
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────

async function handleOptOut(orgId: string, phone: string, body: string): Promise<void> {
  logger.info({ phone, body }, 'TCPA opt-out received');

  await Promise.all([
    prisma.sellerLead.updateMany({
      where: { phone, organizationId: orgId },
      data: { status: SellerStatus.DO_NOT_CONTACT, consentStatus: ConsentStatus.OPTED_OUT, aiPaused: true },
    }),
    prisma.buyerLead.updateMany({
      where: { phone, organizationId: orgId },
      data: { status: BuyerStatus.DO_NOT_CONTACT, consentStatus: ConsentStatus.OPTED_OUT, aiPaused: true },
    }),
    // Cancel scheduled follow-ups
    prisma.followUp.updateMany({
      where: { OR: [
        { seller: { phone, organizationId: orgId } },
        { buyer:  { phone, organizationId: orgId } },
      ], status: 'SCHEDULED' },
      data: { status: 'CANCELLED' },
    }),
    audit.create({
      organizationId: orgId,
      action: 'OPTED_OUT',
      entityType: 'phone',
      entityId: phone,
      meta: { keyword: body },
    }),
  ]);
}

async function getOrgIdFromSid(smsSid: string): Promise<string | null> {
  const msg = await prisma.message.findFirst({ where: { smsSid }, select: { organizationId: true } });
  return msg?.organizationId || null;
}

export default router;
