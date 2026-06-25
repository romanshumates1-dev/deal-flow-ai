// src/workers/followUpWorker.ts
// BullMQ worker that executes scheduled follow-up messages.
// Jobs are created with a `delay` so they persist across restarts.

import { Worker, Job } from 'bullmq';
import { redis } from '../utils/redis';
import { prisma } from '../utils/prisma';
import { smsQueue } from './queues';
import { logger } from '../utils/logger';
import { SellerStatus, BuyerStatus } from '@prisma/client';

export interface FollowUpJobData {
  organizationId: string;
  followUpId: string;
  sellerId?: string;
  buyerId?: string;
  content: string;
  sequenceNumber: number;
}

const SELLER_FOLLOW_UPS = [
  (fname: string, addr?: string) =>
    `Hi ${fname}, just following up! We're still interested in a cash offer for your property${addr ? ' at ' + addr : ''}. Any thoughts?`,
  (fname: string) =>
    `${fname}, checking back in — our all-cash offer is still available with no fees and a fast close. Worth a quick chat?`,
  (fname: string) =>
    `Hey ${fname}, third follow-up here. No pressure at all — if selling is even a distant option, we'd love to be your first call.`,
  (fname: string) =>
    `${fname}, one more check-in on the cash offer for your property. Happy to answer any questions about our process!`,
  (fname: string, addr?: string) =>
    `${fname}, this will be my final message. If selling ever makes sense — now or down the road — please reach out. Wishing you all the best!`,
];

const BUYER_FOLLOW_UPS = [
  (fname: string, feeMin: number, feeMax: number) =>
    `Hi ${fname}, following up on the off-market investment opportunity! Assignment fee $${feeMin.toLocaleString()}–$${feeMax.toLocaleString()}, still available. Interested in details?`,
  (fname: string) =>
    `${fname}, checking back in — this is a fast-close cash deal with strong upside. Happy to answer any questions!`,
  (fname: string) =>
    `Hey ${fname}, third follow-up — if timing or the fee is a concern, I'm very open to a quick conversation.`,
  (fname: string) =>
    `${fname}, one final reach-out — would love to send you the full property package if you're at all open to it.`,
  (fname: string) =>
    `${fname}, final message from me! If you ever want first access to off-market deals in the future, please keep us in mind. Best wishes!`,
];

export function createFollowUpWorker() {
  const worker = new Worker<FollowUpJobData>(
    'follow-up',
    async (job: Job<FollowUpJobData>) => {
      const { organizationId, followUpId, sellerId, buyerId, sequenceNumber } = job.data;

      // Check follow-up is still scheduled (may have been cancelled)
      const followUp = await prisma.followUp.findUnique({
        where: { id: followUpId },
        select: { status: true },
      });
      if (!followUp || followUp.status !== 'SCHEDULED') {
        logger.info({ followUpId }, 'Follow-up cancelled or already sent — skipping');
        return;
      }

      if (sellerId) {
        const seller = await prisma.sellerLead.findFirst({
          where: { id: sellerId, organizationId },
          select: { id: true, name: true, phone: true, status: true, aiPaused: true, followupCount: true, address: true },
        });
        if (!seller) return;

        const skipStatuses: SellerStatus[] = [SellerStatus.AGREED, SellerStatus.LOST, SellerStatus.DO_NOT_CONTACT, SellerStatus.COLD];
        if (skipStatuses.includes(seller.status) || seller.aiPaused) {
          await prisma.followUp.update({ where: { id: followUpId }, data: { status: 'CANCELLED' } });
          return;
        }

        const fname = seller.name.split(' ')[0] || 'there';
        const idx   = Math.min(sequenceNumber - 1, SELLER_FOLLOW_UPS.length - 1);
        const content = SELLER_FOLLOW_UPS[idx](fname, seller.address || undefined);

        await smsQueue.add('send-sms', {
          organizationId,
          to: seller.phone,
          content,
          sellerId,
          role: 'AI',
          isAiGenerated: false,
          followUpId,
        });

        await prisma.sellerLead.update({
          where: { id: seller.id },
          data: { followupCount: { increment: 1 } },
        });

      } else if (buyerId) {
        const buyer = await prisma.buyerLead.findFirst({
          where: { id: buyerId, organizationId },
          select: { id: true, name: true, phone: true, status: true, aiPaused: true, followupCount: true },
        });
        if (!buyer) return;

        const skipStatuses: BuyerStatus[] = [BuyerStatus.AGREED, BuyerStatus.DO_NOT_CONTACT, BuyerStatus.COLD];
        if (skipStatuses.includes(buyer.status) || buyer.aiPaused) {
          await prisma.followUp.update({ where: { id: followUpId }, data: { status: 'CANCELLED' } });
          return;
        }

        // Get negotiation for fee range
        const neg = await prisma.negotiation.findFirst({
          where: { buyerId },
          select: { minOffer: true, maxOffer: true },
        });

        const fname   = buyer.name.split(' ')[0] || 'there';
        const idx     = Math.min(sequenceNumber - 1, BUYER_FOLLOW_UPS.length - 1);
        const content = BUYER_FOLLOW_UPS[idx](fname, neg?.minOffer || 0, neg?.maxOffer || 0);

        await smsQueue.add('send-sms', {
          organizationId,
          to: buyer.phone,
          content,
          buyerId,
          role: 'AI',
          isAiGenerated: false,
          followUpId,
        });

        await prisma.buyerLead.update({
          where: { id: buyer.id },
          data: { followupCount: { increment: 1 } },
        });
      }
    },
    {
      connection: { host: redis.options.host, port: redis.options.port },
      concurrency: 20,
    }
  );

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, followUpId: job?.data.followUpId, err: err.message }, 'Follow-up job failed');
    if (job?.data.followUpId) {
      prisma.followUp.update({
        where: { id: job.data.followUpId },
        data: { status: 'FAILED', failedAt: new Date(), failReason: err.message },
      }).catch(() => {});
    }
  });

  return worker;
}

/** Schedule follow-up jobs for a seller lead */
export async function scheduleSellerFollowUps(
  organizationId: string,
  sellerId: string,
  maxFollowups: number,
  delayHours: number
): Promise<void> {
  // Cancel any existing scheduled follow-ups
  await prisma.followUp.updateMany({
    where: { sellerId, status: 'SCHEDULED' },
    data: { status: 'CANCELLED' },
  });

  const seller = await prisma.sellerLead.findUnique({
    where: { id: sellerId },
    select: { name: true, phone: true, address: true, followupCount: true },
  });
  if (!seller) return;

  const currentCount = seller.followupCount || 0;
  const remaining    = maxFollowups - currentCount;
  if (remaining <= 0) return;

  for (let i = 1; i <= remaining; i++) {
    const delayMs       = i * delayHours * 3_600_000;
    const scheduledFor  = new Date(Date.now() + delayMs);
    const fname         = seller.name.split(' ')[0] || 'there';
    const idx           = Math.min(currentCount + i - 1, SELLER_FOLLOW_UPS.length - 1);
    const content       = SELLER_FOLLOW_UPS[idx](fname, seller.address || undefined);

    const followUp = await prisma.followUp.create({
      data: { organizationId, sellerId, sequenceNumber: currentCount + i, content, scheduledFor },
    });

    const job = await followUpQueue.add(
      'follow-up',
      { organizationId, followUpId: followUp.id, sellerId, content, sequenceNumber: currentCount + i },
      { delay: delayMs }
    );

    await prisma.followUp.update({
      where: { id: followUp.id },
      data: { bullJobId: job.id?.toString() },
    });
  }
}

/** Schedule follow-up jobs for a buyer lead */
export async function scheduleBuyerFollowUps(
  organizationId: string,
  buyerId: string,
  maxFollowups: number,
  delayHours: number,
  feeMin: number,
  feeMax: number
): Promise<void> {
  await prisma.followUp.updateMany({
    where: { buyerId, status: 'SCHEDULED' },
    data: { status: 'CANCELLED' },
  });

  const buyer = await prisma.buyerLead.findUnique({
    where: { id: buyerId },
    select: { name: true, followupCount: true },
  });
  if (!buyer) return;

  const currentCount = buyer.followupCount || 0;
  const remaining    = maxFollowups - currentCount;
  if (remaining <= 0) return;

  for (let i = 1; i <= remaining; i++) {
    const delayMs      = i * delayHours * 3_600_000;
    const scheduledFor = new Date(Date.now() + delayMs);
    const fname        = buyer.name.split(' ')[0] || 'there';
    const idx          = Math.min(currentCount + i - 1, BUYER_FOLLOW_UPS.length - 1);
    const content      = BUYER_FOLLOW_UPS[idx](fname, feeMin, feeMax);

    const followUp = await prisma.followUp.create({
      data: { organizationId, buyerId, sequenceNumber: currentCount + i, content, scheduledFor },
    });

    const job = await followUpQueue.add(
      'follow-up',
      { organizationId, followUpId: followUp.id, buyerId, content, sequenceNumber: currentCount + i },
      { delay: delayMs }
    );

    await prisma.followUp.update({
      where: { id: followUp.id },
      data: { bullJobId: job.id?.toString() },
    });
  }
}
