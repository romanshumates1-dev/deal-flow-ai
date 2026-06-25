// src/workers/aiWorker.ts
// Processes inbound SMS through the AI pipeline:
// classify intent → generate response → queue outbound SMS → update lead status

import { Worker, Job } from 'bullmq';
import { redis } from '../utils/redis';
import { prisma } from '../utils/prisma';
import { smsQueue } from './queues';
import { logger } from '../utils/logger';
import {
  callClaude, classifySellerIntent, classifyNegotiationIntent,
  extractPriceFromMessage, buildSellerQualifyPrompt, buildSellerNegotiatePrompt,
  buildBuyerPitchPrompt, buildBuyerNegotiatePrompt,
} from '../services/ai';
import { audit } from '../services/audit';
import { SellerStatus, BuyerStatus, MessageRole, OfferParty } from '@prisma/client';

export interface AiJobData {
  organizationId: string;
  inboundMessageId: string;     // Message record for the inbound SMS
  sellerId?: string;
  buyerId?: string;
  inboundText: string;
}

const fmt = (n: number) => `$${n.toLocaleString()}`;

export function createAiWorker() {
  const worker = new Worker<AiJobData>(
    'ai',
    async (job: Job<AiJobData>) => {
      const { organizationId, sellerId, buyerId, inboundText } = job.data;

      const org = await prisma.organization.findUnique({
        where: { id: organizationId },
        select: { aiPersona: true, companyName: false, msgTone: true, anthropicKey: true,
                  twilioSid: true, twilioToken: true, twilioFrom: true, name: true },
      });
      if (!org) throw new Error(`Org ${organizationId} not found`);

      const orgConfig = {
        aiPersona:    (org as any).aiPersona,
        companyName:  (org as any).name,
        msgTone:      (org as any).msgTone,
        anthropicKey: (org as any).anthropicKey,
      };

      if (sellerId) {
        await processSellerMessage(organizationId, sellerId, inboundText, orgConfig);
      } else if (buyerId) {
        await processBuyerMessage(organizationId, buyerId, inboundText, orgConfig);
      }
    },
    {
      connection: { host: redis.options.host, port: redis.options.port },
      concurrency: 10,   // up to 10 simultaneous AI calls
      limiter: {
        max: 50,          // respect Anthropic rate limit
        duration: 60_000,
      },
    }
  );

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err: err.message }, 'AI job failed');
  });

  return worker;
}

// ─── Seller message processing ────────────────────────────────────────────

async function processSellerMessage(
  orgId: string,
  sellerId: string,
  inboundText: string,
  org: any
) {
  const seller = await prisma.sellerLead.findFirst({
    where: { id: sellerId, organizationId: orgId },
    include: {
      negotiation: { include: { offers: { orderBy: { createdAt: 'asc' } } } },
    },
  });
  if (!seller) return;

  // Respect manual pause
  if (seller.aiPaused) return;

  // If negotiation is active, route to negotiation handler
  if (seller.negotiationActive && seller.negotiation) {
    await handleSellerNegotiation(orgId, seller, inboundText, org);
    return;
  }

  // Qualify / FAQ / not interested
  const intent = await classifySellerIntent(inboundText, org);
  logger.info({ sellerId, intent }, 'Seller intent classified');

  if (intent === 'not_interested') {
    const aiText = await callClaude({
      org,
      system: buildSellerQualifyPrompt(org, seller.name, seller.address || undefined),
      messages: [{ role: 'user', content: `The seller said: "${inboundText}". They do NOT want to sell right now. Send a warm 2-sentence goodbye. Thank them sincerely, leave door open for the future.` }],
      maxTokens: 200,
    });

    const fname = seller.name.split(' ')[0] || 'there';
    const msg = aiText ||
      `Absolutely no problem, ${fname} — thank you so much for your time! If anything ever changes, please don't hesitate to reach out. Wishing you all the best!`;

    await queueSms(orgId, seller.phone, msg, sellerId, undefined, 'AI', true);

    await prisma.$transaction([
      prisma.sellerLead.update({
        where: { id: sellerId },
        data: { status: SellerStatus.LOST, aiPaused: true, removedAt: new Date() },
      }),
      prisma.followUp.updateMany({
        where: { sellerId, status: 'SCHEDULED' },
        data: { status: 'CANCELLED' },
      }),
    ]);

    await createOrgNotification(orgId, 'INFO', `Lead removed: ${seller.name}`, 'Prospect is not interested — AI sent a polite goodbye.');
    await audit.create({ organizationId: orgId, action: 'DEAL_LOST', entityType: 'seller_lead', entityId: sellerId });

  } else {
    // Interested, FAQ, or unclear — keep conversation going
    const recentMessages = await prisma.message.findMany({
      where: { sellerId },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { role: true, content: true },
    });

    const history = recentMessages.reverse().map(m => ({
      role: (m.role === 'AI' ? 'assistant' : 'user') as 'assistant' | 'user',
      content: m.content,
    }));

    const aiText = await callClaude({
      org,
      system: buildSellerQualifyPrompt(org, seller.name, seller.address || undefined),
      messages: [...history, { role: 'user', content: inboundText }],
    });

    const msg = aiText ||
      `That's great to hear! We work with homeowners in many situations — inherited properties, relocations, or just ready to simplify. What does your timeline look like?`;

    await queueSms(orgId, seller.phone, msg, sellerId, undefined, 'AI', true);

    if (!['WARM', 'NEGOTIATING', 'AGREED'].includes(seller.status)) {
      await prisma.sellerLead.update({
        where: { id: sellerId },
        data: { status: SellerStatus.WARM, score: Math.min(100, (seller.score || 50) + 20) },
      });
      await createOrgNotification(
        orgId, 'WARNING',
        `Interested seller: ${seller.name}`,
        `${seller.name} appears open to selling${seller.address ? ' (' + seller.address + ')' : ''}. Set your price range to begin AI negotiation.`,
      );
    }
  }
}

async function handleSellerNegotiation(
  orgId: string,
  seller: any,
  inboundText: string,
  org: any
) {
  const neg = seller.negotiation;
  const offers: Array<{ party: OfferParty; amount: number }> = neg.offers.map((o: any) => ({
    party: o.party, amount: o.amount,
  }));

  const lastAiOffer = neg.offers.filter((o: any) => o.party === 'AI').pop()?.amount || neg.minOffer;
  const { intent, price } = classifyNegotiationIntent(inboundText, lastAiOffer);

  logger.info({ sellerId: seller.id, intent, price }, 'Seller negotiation intent');

  const systemPrompt = buildSellerNegotiatePrompt(org, {
    sellerName:   seller.name,
    address:      seller.address || undefined,
    openingOffer: neg.minOffer,
    minOffer:     neg.minOffer,
    maxOffer:     neg.maxOffer,
    offerHistory: offers,
  });

  if (intent === 'agreed') {
    const agreedAt = price || lastAiOffer;
    if (agreedAt > neg.maxOffer) {
      // Their "agreed" price is above our ceiling — can't accept
      await handleSellerWalkaway(orgId, seller, neg, org, systemPrompt);
      return;
    }

    const aiText = await callClaude({
      org, system: systemPrompt,
      messages: [{ role: 'user', content: `The seller agreed to ${fmt(agreedAt)}! Express genuine enthusiasm, confirm the verbal agreement, and let them know a purchase agreement is coming soon. 3 sentences.` }],
    });

    const msg = aiText ||
      `We have a deal at ${fmt(agreedAt)} — I couldn't be more excited! I'll have a purchase agreement sent over for your review very shortly. Thank you for trusting us with this!`;

    await queueSms(orgId, seller.phone, msg, seller.id, undefined, 'AI', true);

    await prisma.$transaction(async (tx) => {
      await tx.negotiationOffer.create({ data: { negotiationId: neg.id, party: 'PROSPECT', amount: agreedAt } });
      await tx.negotiation.update({ where: { id: neg.id }, data: { status: 'AGREED', agreedAmount: agreedAt } });
      await tx.sellerLead.update({
        where: { id: seller.id },
        data: { status: SellerStatus.AGREED, agreedPrice: agreedAt, negotiationActive: false, score: 100 },
      });
    });

    await createOrgNotification(orgId, 'SUCCESS',
      `Deal agreed — ${seller.address || seller.name}`,
      `${seller.name} verbally agreed to ${fmt(agreedAt)}. Upload and send a purchase agreement now.`
    );
    await audit.create({ organizationId: orgId, action: 'DEAL_AGREED', entityType: 'seller_lead', entityId: seller.id, after: { agreedPrice: agreedAt } });

  } else if (intent === 'counter' && price) {
    await prisma.negotiationOffer.create({ data: { negotiationId: neg.id, party: 'PROSPECT', amount: price, isCounterOffer: true } });

    if (price > neg.maxOffer) {
      if (lastAiOffer >= neg.maxOffer) {
        await handleSellerWalkaway(orgId, seller, neg, org, systemPrompt);
        return;
      }
      // Move to max as final offer
      const aiText = await callClaude({
        org, system: systemPrompt,
        messages: [{ role: 'user', content: `Counter at ${fmt(price)} exceeds our max of ${fmt(neg.maxOffer)}. Move to ${fmt(neg.maxOffer)} as absolute final. Firm but respectful. 4 sentences.` }],
      });
      const msg = aiText || `I want to make this work — the absolute most we can do is ${fmt(neg.maxOffer)}, and that's our final ceiling. This still comes with all-cash, no fees, and a 7-day close. Can we land there?`;
      await queueSms(orgId, seller.phone, msg, seller.id, undefined, 'AI', true);
      await prisma.negotiationOffer.create({ data: { negotiationId: neg.id, party: 'AI', amount: neg.maxOffer } });
    } else {
      const gap = price - lastAiOffer;
      const nextOffer = Math.min(neg.maxOffer, Math.round(lastAiOffer + gap * 0.55));
      const aiText = await callClaude({
        org, system: systemPrompt,
        messages: [{ role: 'user', content: `Seller countered at ${fmt(price)}. Move to ${fmt(nextOffer)}, justify the value. 4 sentences.` }],
      });
      const msg = aiText || `I hear you — let me move to ${fmt(nextOffer)}. That's all-cash, no fees, no repairs, close in 7 days. Can we meet there?`;
      await queueSms(orgId, seller.phone, msg, seller.id, undefined, 'AI', true);
      await prisma.negotiationOffer.create({ data: { negotiationId: neg.id, party: 'AI', amount: nextOffer } });
    }

  } else if (intent === 'firm_no') {
    await handleSellerWalkaway(orgId, seller, neg, org, systemPrompt);
  } else {
    const aiText = await callClaude({
      org, system: systemPrompt,
      messages: [{ role: 'user', content: `Prospect said: "${inboundText}". Re-engage professionally, re-anchor to current offer of ${fmt(lastAiOffer)}. Brief.` }],
    });
    const msg = aiText || `Our current offer is ${fmt(lastAiOffer)} — all cash, no strings attached. Is there anything I can clarify to help you decide?`;
    await queueSms(orgId, seller.phone, msg, seller.id, undefined, 'AI', true);
  }
}

async function handleSellerWalkaway(orgId: string, seller: any, neg: any, org: any, systemPrompt: string) {
  const fname = seller.name.split(' ')[0] || 'there';
  const aiText = await callClaude({
    org, system: systemPrompt,
    messages: [{ role: 'user', content: `We cannot agree on price. Send a gracious 3-sentence walkaway. Express genuine appreciation, acknowledge their position, leave door wide open for the future.` }],
  });
  const msg = aiText ||
    `I really appreciate your time, ${fname} — I only wish we could have landed at a number that worked for both of us. If your situation ever changes, please don't hesitate to reach back out. Wishing you all the best!`;
  await queueSms(orgId, seller.phone, msg, seller.id, undefined, 'AI', true);
  await prisma.$transaction([
    prisma.sellerLead.update({ where: { id: seller.id }, data: { status: SellerStatus.COLD, negotiationActive: false } }),
    prisma.negotiation.update({ where: { id: neg.id }, data: { status: 'ENDED' } }),
  ]);
  await audit.create({ organizationId: orgId, action: 'DEAL_LOST', entityType: 'seller_lead', entityId: seller.id });
}

// ─── Buyer message processing ─────────────────────────────────────────────

async function processBuyerMessage(orgId: string, buyerId: string, inboundText: string, org: any) {
  const buyer = await prisma.buyerLead.findFirst({
    where: { id: buyerId, organizationId: orgId },
    include: {
      negotiation: { include: { offers: { orderBy: { createdAt: 'asc' } } } },
    },
  });
  if (!buyer || buyer.aiPaused) return;

  const NOT_INTERESTED = ['not interested','no thanks','pass','no deal','too high','forget it'];
  const lower = inboundText.toLowerCase();

  if (buyer.negotiationActive && buyer.negotiation) {
    const neg = buyer.negotiation;
    const lastAiOffer = neg.offers.filter((o: any) => o.party === 'AI').pop()?.amount || neg.maxOffer;
    const price = extractPriceFromMessage(inboundText, 500);

    const AGREED = ['deal','i accept','lets do it','agreed','sounds good','you got it','yes lets go'];
    if (AGREED.some(k => lower.includes(k))) {
      const agreedFee = price || lastAiOffer;
      if (agreedFee >= neg.minOffer) {
        const aiText = await callClaude({
          org,
          system: buildBuyerNegotiatePrompt(org, { feeMin: neg.minOffer, feeMax: neg.maxOffer, offerHistory: neg.offers }),
          messages: [{ role: 'user', content: `Buyer agreed at ${fmt(agreedFee)}! Confirm enthusiastically, next steps. 3 sentences.` }],
        });
        const msg = aiText || `Excellent — we have a deal at ${fmt(agreedFee)}! I'll get the assignment agreement over to you right away. Welcome aboard!`;
        await queueSms(orgId, buyer.phone, msg, undefined, buyerId, 'AI', true);
        await prisma.$transaction([
          prisma.buyerLead.update({ where: { id: buyerId }, data: { status: BuyerStatus.AGREED, agreedFee, negotiationActive: false, score: 100 } }),
          prisma.negotiation.update({ where: { id: neg.id }, data: { status: 'AGREED', agreedAmount: agreedFee } }),
        ]);
        await createOrgNotification(orgId, 'SUCCESS', `Buyer agreed: ${buyer.name}`, `${buyer.name} agreed to a ${fmt(agreedFee)} assignment fee. Send the contract.`);
      }
    } else if (price && price < lastAiOffer) {
      const counter = Math.max(neg.minOffer, Math.round((lastAiOffer + price) / 2));
      const aiText = await callClaude({
        org,
        system: buildBuyerNegotiatePrompt(org, { feeMin: neg.minOffer, feeMax: neg.maxOffer, offerHistory: neg.offers }),
        messages: [{ role: 'user', content: `Buyer countered at ${fmt(price)}. Counter at ${fmt(counter)}. 3 sentences.` }],
      });
      const msg = aiText || `How about we split the difference at ${fmt(counter)}? At that price you're walking into a deal with exceptional upside. Let's make it happen!`;
      await queueSms(orgId, buyer.phone, msg, undefined, buyerId, 'AI', true);
      await prisma.negotiationOffer.create({ data: { negotiationId: neg.id, party: 'AI', amount: counter } });
    } else if (NOT_INTERESTED.some(k => lower.includes(k))) {
      const fname = buyer.name.split(' ')[0] || 'there';
      const msg = `Completely understand, ${fname} — not every deal is the right fit. If you ever want first access to future off-market assignments, please keep us in mind!`;
      await queueSms(orgId, buyer.phone, msg, undefined, buyerId, 'AI', true);
      await prisma.buyerLead.update({ where: { id: buyerId }, data: { status: BuyerStatus.COLD, negotiationActive: false } });
    }
    return;
  }

  // New buyer — pitch the deal
  if (NOT_INTERESTED.some(k => lower.includes(k))) {
    const fname = buyer.name.split(' ')[0] || 'there';
    const msg = `Thank you for your time, ${fname}! If you ever want to hear about future off-market deals, just let us know. Best of luck with your portfolio!`;
    await queueSms(orgId, buyer.phone, msg, undefined, buyerId, 'AI', true);
    await prisma.buyerLead.update({ where: { id: buyerId }, data: { status: BuyerStatus.COLD } });
    return;
  }

  // Interested or FAQ — pitch and move to negotiation
  const neg = await prisma.negotiation.findFirst({ where: { buyerId } });
  if (!neg) return; // no negotiation record — shouldn't happen

  const aiText = await callClaude({
    org,
    system: buildBuyerPitchPrompt(org, { buyerName: buyer.name, feeMin: neg.minOffer, feeMax: neg.maxOffer }),
    messages: [{ role: 'user', content: inboundText }],
  });
  const msg = aiText || `Great question! This is a strong cash deal with solid ARV upside. The assignment fee is ${fmt(neg.maxOffer)} — does that work for you, or would you like to discuss?`;
  await queueSms(orgId, buyer.phone, msg, undefined, buyerId, 'AI', true);

  await prisma.$transaction([
    prisma.buyerLead.update({ where: { id: buyerId }, data: { status: BuyerStatus.NEGOTIATING, negotiationActive: true, score: Math.min(100, (buyer.score || 50) + 25) } }),
    prisma.negotiationOffer.create({ data: { negotiationId: neg.id, party: 'AI', amount: neg.maxOffer } }),
  ]);
}

// ─── Shared helpers ────────────────────────────────────────────────────────

async function queueSms(
  orgId: string,
  to: string,
  content: string,
  sellerId?: string,
  buyerId?: string,
  role: MessageRole = 'AI',
  isAiGenerated = false
) {
  await smsQueue.add('send-sms', { organizationId: orgId, to, content, sellerId, buyerId, role, isAiGenerated }, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2_000 },
  });
}

async function createOrgNotification(
  orgId: string,
  type: 'SUCCESS' | 'WARNING' | 'DANGER' | 'INFO',
  title: string,
  body: string
) {
  await prisma.notification.create({ data: { organizationId: orgId, type, title, body } });
}
