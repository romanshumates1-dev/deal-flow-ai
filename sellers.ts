// src/routes/sellers.ts
import { Router, Request, Response } from 'express';
import { body, query, param, validationResult } from 'express-validator';
import { prisma } from '../utils/prisma';
import { ApiError, asyncHandler } from '../utils/errors';
import { authenticate, requireManager, requireAcquisition, requireAny } from '../middleware/authenticate';
import { audit } from '../services/audit';
import { smsQueue, aiQueue, followUpQueue } from '../workers/queues';
import { normalizePhone } from '../utils/phone';
import { sanitizeText, escapeHtml } from '../utils/sanitize';
import { paginate, PaginatedResult } from '../utils/paginate';
import { exportToCsv } from '../utils/export';
import { SellerStatus, ConsentStatus } from '@prisma/client';

const router = Router();

// All seller routes require authentication
router.use(authenticate);

// ─────────────────────────────────────────────────────────
// LIST SELLERS — with filtering, search, sorting, pagination
// ─────────────────────────────────────────────────────────

router.get('/',
  query('page').optional().isInt({ min: 1 }).toInt(),
  query('limit').optional().isInt({ min: 1, max: 200 }).toInt(),
  query('status').optional().isIn(Object.values(SellerStatus)),
  query('campaignId').optional().isString(),
  query('search').optional().isString().trim(),
  query('ownerId').optional().isString(),
  query('scoreMin').optional().isInt({ min: 0, max: 100 }).toInt(),
  query('scoreMax').optional().isInt({ min: 0, max: 100 }).toInt(),
  query('sortBy').optional().isIn(['createdAt', 'score', 'name', 'updatedAt']),
  query('sortDir').optional().isIn(['asc', 'desc']),
  asyncHandler(async (req: Request, res: Response) => {
    const {
      page = 1, limit = 50, status, campaignId, search,
      ownerId, scoreMin, scoreMax, sortBy = 'createdAt', sortDir = 'desc',
    } = req.query as Record<string, any>;

    const where: any = {
      organizationId: req.organizationId,
      ...(status && { status: status as SellerStatus }),
      ...(campaignId && { campaignId }),
      ...(ownerId && { ownerId }),
      ...(scoreMin !== undefined && { score: { gte: scoreMin } }),
      ...(scoreMax !== undefined && { score: { lte: scoreMax } }),
      ...(search && {
        OR: [
          { name: { contains: search, mode: 'insensitive' } },
          { phone: { contains: search } },
          { email: { contains: search, mode: 'insensitive' } },
          { address: { contains: search, mode: 'insensitive' } },
        ],
      }),
      // Never include opted-out unless explicitly filtered
      NOT: status
        ? undefined
        : { status: SellerStatus.DO_NOT_CONTACT },
    };

    const [sellers, total] = await Promise.all([
      prisma.sellerLead.findMany({
        where,
        select: {
          id: true, name: true, phone: true, email: true,
          address: true, city: true, state: true,
          status: true, score: true, motivationScore: true,
          aiPaused: true, negotiationActive: true,
          followupCount: true, contractSent: true,
          priceMin: true, priceMax: true, lastAiOffer: true, agreedPrice: true,
          consentStatus: true, source: true,
          createdAt: true, updatedAt: true,
          campaign: { select: { id: true, name: true } },
          owner: { select: { id: true, firstName: true, lastName: true } },
          tags: { include: { tag: true } },
          _count: { select: { messages: true } },
        },
        orderBy: { [sortBy]: sortDir },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.sellerLead.count({ where }),
    ]);

    res.json(paginate(sellers, page, limit, total));
  })
);

// ─────────────────────────────────────────────────────────
// EXPORT CSV
// ─────────────────────────────────────────────────────────

router.get('/export',
  requireAny,
  asyncHandler(async (req: Request, res: Response) => {
    const sellers = await prisma.sellerLead.findMany({
      where: {
        organizationId: req.organizationId!,
        NOT: { status: SellerStatus.DO_NOT_CONTACT },
      },
      select: {
        name: true, phone: true, email: true, address: true, city: true,
        state: true, zip: true, status: true, score: true, followupCount: true,
        agreedPrice: true, source: true, createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    const csv = exportToCsv(sellers, [
      { key: 'name', label: 'Name' },
      { key: 'phone', label: 'Phone' },
      { key: 'email', label: 'Email' },
      { key: 'address', label: 'Address' },
      { key: 'city', label: 'City' },
      { key: 'state', label: 'State' },
      { key: 'zip', label: 'ZIP' },
      { key: 'status', label: 'Status' },
      { key: 'score', label: 'Score' },
      { key: 'followupCount', label: 'Follow-ups' },
      { key: 'agreedPrice', label: 'Agreed Price' },
      { key: 'source', label: 'Source' },
      { key: 'createdAt', label: 'Created' },
    ]);

    res.set({
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="sellers-${Date.now()}.csv"`,
    });
    res.send(csv);
  })
);

// ─────────────────────────────────────────────────────────
// GET SINGLE SELLER (with full message history)
// ─────────────────────────────────────────────────────────

router.get('/:id',
  param('id').isString().trim(),
  asyncHandler(async (req: Request, res: Response) => {
    const seller = await prisma.sellerLead.findFirst({
      where: { id: req.params.id, organizationId: req.organizationId! },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true, role: true, content: true, smsStatus: true,
            isAiGenerated: true, createdAt: true,
          },
        },
        negotiation: {
          include: { offers: { orderBy: { createdAt: 'asc' } } },
        },
        contract: true,
        followUps: { orderBy: { scheduledFor: 'asc' } },
        tags: { include: { tag: true } },
        campaign: { select: { id: true, name: true } },
        owner: { select: { id: true, firstName: true, lastName: true } },
      },
    });

    if (!seller) throw new ApiError(404, 'Seller not found');
    res.json(seller);
  })
);

// ─────────────────────────────────────────────────────────
// IMPORT SELLERS (bulk CSV/JSON)
// ─────────────────────────────────────────────────────────

router.post('/import',
  requireAcquisition,
  body('leads').isArray({ min: 1, max: 10_000 }),
  body('leads.*.phone').notEmpty().isString(),
  body('leads.*.name').optional().isString().trim(),
  body('leads.*.address').optional().isString().trim(),
  body('leads.*.email').optional().isEmail(),
  body('campaignId').optional().isString(),
  body('source').optional().isString().trim(),
  asyncHandler(async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ApiError(400, 'Validation failed', 'VALIDATION_ERROR', errors.array());
    }

    const { leads, campaignId, source } = req.body;
    const orgId = req.organizationId!;

    // Get existing phones in this org to detect duplicates
    const existingPhones = await prisma.sellerLead.findMany({
      where: { organizationId: orgId },
      select: { phone: true },
    });
    // Also check buyers to prevent cross-list duplicates
    const existingBuyerPhones = await prisma.buyerLead.findMany({
      where: { organizationId: orgId },
      select: { phone: true },
    });

    const existingSet = new Set([
      ...existingPhones.map(r => r.phone),
      ...existingBuyerPhones.map(r => r.phone),
    ]);

    const toCreate: any[] = [];
    const duplicates: string[] = [];
    const invalid: string[] = [];

    for (const lead of leads) {
      const phone = normalizePhone(lead.phone);
      if (!phone) { invalid.push(lead.phone); continue; }
      if (existingSet.has(phone)) { duplicates.push(phone); continue; }

      existingSet.add(phone); // prevent in-batch duplicates
      toCreate.push({
        organizationId: orgId,
        campaignId: campaignId || null,
        name: sanitizeText(lead.name) || phone,
        phone,
        email: lead.email || null,
        address: sanitizeText(lead.address) || null,
        city: sanitizeText(lead.city) || null,
        state: sanitizeText(lead.state) || null,
        zip: sanitizeText(lead.zip) || null,
        source: sanitizeText(source) || 'import',
        consentStatus: ConsentStatus.PENDING,
        consentMethod: 'import',
        importedAt: new Date(),
      });
    }

    if (!toCreate.length) {
      return res.status(200).json({
        added: 0,
        duplicates: duplicates.length,
        invalid: invalid.length,
        message: 'No new leads to add',
      });
    }

    // Batch insert (createMany is much faster than individual creates)
    const result = await prisma.sellerLead.createMany({ data: toCreate });

    await audit.create({
      organizationId: orgId,
      userId: req.user!.sub,
      action: 'CREATED',
      entityType: 'seller_lead_batch',
      entityId: campaignId || orgId,
      meta: { count: result.count, source },
      ip: req.ip,
    });

    // Start campaign: queue initial outreach messages for all new sellers
    const newSellers = await prisma.sellerLead.findMany({
      where: {
        organizationId: orgId,
        importedAt: { gte: new Date(Date.now() - 5000) }, // just imported
        campaignId: campaignId || null,
      },
      select: { id: true, phone: true, name: true, address: true },
    });

    // Queue outreach with staggered delays (2.5s between sends)
    let delay = 0;
    for (const seller of newSellers) {
      await smsQueue.add('seller-outreach', {
        sellerId: seller.id,
        organizationId: orgId,
      }, {
        delay,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      });
      delay += 2500;
    }

    res.status(201).json({
      added: result.count,
      duplicates: duplicates.length,
      invalid: invalid.length,
      queued: newSellers.length,
    });
  })
);

// ─────────────────────────────────────────────────────────
// SET PRICE RANGE (activates AI negotiation)
// ─────────────────────────────────────────────────────────

router.post('/:id/price',
  requireAcquisition,
  param('id').isString().trim(),
  body('priceMin').isInt({ min: 1 }).toInt(),
  body('priceMax').isInt({ min: 1 }).toInt(),
  body('priceLowball').optional().isInt({ min: 1 }).toInt(),
  body('priceNotes').optional().isString().trim().isLength({ max: 1000 }),
  asyncHandler(async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) throw new ApiError(400, 'Invalid price range');

    const seller = await prisma.sellerLead.findFirst({
      where: { id: req.params.id, organizationId: req.organizationId! },
    });
    if (!seller) throw new ApiError(404, 'Seller not found');
    if (seller.status === SellerStatus.DO_NOT_CONTACT) {
      throw new ApiError(403, 'Cannot interact with opted-out contact');
    }

    const { priceMin, priceMax, priceLowball, priceNotes } = req.body;
    if (priceMin >= priceMax) {
      throw new ApiError(400, 'priceMin must be less than priceMax');
    }

    const before = {
      status: seller.status,
      priceMin: seller.priceMin,
      priceMax: seller.priceMax,
    };

    const updated = await prisma.sellerLead.update({
      where: { id: seller.id },
      data: {
        priceMin,
        priceMax,
        priceLowball: priceLowball || priceMin,
        priceNotes: priceNotes || null,
        status: SellerStatus.NEGOTIATING,
        negotiationActive: true,
      },
    });

    // Create or update negotiation record
    await prisma.negotiation.upsert({
      where: { sellerId: seller.id },
      create: {
        organizationId: req.organizationId!,
        sellerId: seller.id,
        side: 'SELLER',
        floorPrice: priceMin,
        ceilPrice: priceMax,
        openingOffer: priceLowball || priceMin,
        currentOffer: priceLowball || priceMin,
        status: 'active',
        notes: priceNotes || null,
      },
      update: {
        floorPrice: priceMin,
        ceilPrice: priceMax,
        openingOffer: priceLowball || priceMin,
        currentOffer: priceLowball || priceMin,
        status: 'active',
        notes: priceNotes || null,
      },
    });

    // Queue the AI's opening offer message
    await aiQueue.add('seller-negotiation-start', {
      sellerId: seller.id,
      organizationId: req.organizationId!,
    }, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 3000 },
    });

    await audit.create({
      organizationId: req.organizationId!,
      userId: req.user!.sub,
      action: 'PRICE_SET',
      entityType: 'seller_lead',
      entityId: seller.id,
      before,
      after: { priceMin, priceMax, priceLowball, status: 'NEGOTIATING' },
      ip: req.ip,
    });

    res.json({ ok: true, seller: updated });
  })
);

// ─────────────────────────────────────────────────────────
// PAUSE / RESUME AI
// ─────────────────────────────────────────────────────────

router.post('/:id/pause',
  requireAny,
  param('id').isString().trim(),
  body('paused').isBoolean(),
  asyncHandler(async (req: Request, res: Response) => {
    const seller = await prisma.sellerLead.findFirst({
      where: { id: req.params.id, organizationId: req.organizationId! },
      select: { id: true, aiPaused: true, status: true },
    });
    if (!seller) throw new ApiError(404, 'Seller not found');

    const { paused } = req.body;

    await prisma.sellerLead.update({
      where: { id: seller.id },
      data: { aiPaused: paused },
    });

    if (paused) {
      // Cancel pending follow-ups
      const pending = await prisma.followUp.findMany({
        where: { sellerId: seller.id, status: 'SCHEDULED' },
        select: { id: true, bullJobId: true },
      });
      for (const fu of pending) {
        if (fu.bullJobId) {
          const job = await followUpQueue.getJob(fu.bullJobId);
          await job?.remove();
        }
        await prisma.followUp.update({
          where: { id: fu.id },
          data: { status: 'CANCELLED' },
        });
      }
    } else {
      // Re-schedule next follow-up
      await aiQueue.add('reschedule-seller-followup', {
        sellerId: seller.id,
        organizationId: req.organizationId!,
      });
    }

    await audit.create({
      organizationId: req.organizationId!,
      userId: req.user!.sub,
      action: paused ? 'AI_PAUSED' : 'AI_RESUMED',
      entityType: 'seller_lead',
      entityId: seller.id,
      ip: req.ip,
    });

    res.json({ ok: true, aiPaused: paused });
  })
);

// ─────────────────────────────────────────────────────────
// REMOVE (soft delete — mark as LOST)
// ─────────────────────────────────────────────────────────

router.delete('/:id',
  requireAny,
  asyncHandler(async (req: Request, res: Response) => {
    const seller = await prisma.sellerLead.findFirst({
      where: { id: req.params.id, organizationId: req.organizationId! },
      select: { id: true, status: true },
    });
    if (!seller) throw new ApiError(404, 'Seller not found');

    // Cancel scheduled follow-ups
    await followUpQueue.removeJobScheduler(`followup-seller-${seller.id}`);

    await prisma.$transaction([
      prisma.sellerLead.update({
        where: { id: seller.id },
        data: {
          status: SellerStatus.LOST,
          aiPaused: true,
          removedAt: new Date(),
          negotiationActive: false,
        },
      }),
      prisma.followUp.updateMany({
        where: { sellerId: seller.id, status: 'SCHEDULED' },
        data: { status: 'CANCELLED' },
      }),
    ]);

    await audit.create({
      organizationId: req.organizationId!,
      userId: req.user!.sub,
      action: 'DELETED',
      entityType: 'seller_lead',
      entityId: seller.id,
      before: { status: seller.status },
      after: { status: 'LOST' },
      ip: req.ip,
    });

    res.json({ ok: true });
  })
);

// ─────────────────────────────────────────────────────────
// REINSTATE
// ─────────────────────────────────────────────────────────

router.post('/:id/reinstate',
  requireManager,
  asyncHandler(async (req: Request, res: Response) => {
    const seller = await prisma.sellerLead.findFirst({
      where: { id: req.params.id, organizationId: req.organizationId! },
      select: { id: true, status: true, phone: true },
    });
    if (!seller) throw new ApiError(404, 'Seller not found');

    if (seller.status === SellerStatus.DO_NOT_CONTACT) {
      throw new ApiError(403, 'Cannot reinstate opted-out contact — TCPA compliance');
    }

    await prisma.sellerLead.update({
      where: { id: seller.id },
      data: {
        status: SellerStatus.NEW,
        aiPaused: false,
        removedAt: null,
        reinstatedAt: new Date(),
        followupCount: 0,
        score: 50,
      },
    });

    await audit.create({
      organizationId: req.organizationId!,
      userId: req.user!.sub,
      action: 'REINSTATED',
      entityType: 'seller_lead',
      entityId: seller.id,
      ip: req.ip,
    });

    res.json({ ok: true });
  })
);

// ─────────────────────────────────────────────────────────
// SEND MANUAL MESSAGE
// ─────────────────────────────────────────────────────────

router.post('/:id/message',
  requireAny,
  param('id').isString().trim(),
  body('content').isString().trim().isLength({ min: 1, max: 1600 }),
  asyncHandler(async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) throw new ApiError(400, 'Content required (max 1600 chars)');

    const seller = await prisma.sellerLead.findFirst({
      where: { id: req.params.id, organizationId: req.organizationId! },
      select: { id: true, phone: true, status: true, consentStatus: true },
    });
    if (!seller) throw new ApiError(404, 'Seller not found');
    if (seller.status === SellerStatus.DO_NOT_CONTACT || seller.consentStatus === ConsentStatus.OPTED_OUT) {
      throw new ApiError(403, 'Cannot send to opted-out contact');
    }

    // Queue SMS send
    await smsQueue.add('send-sms', {
      organizationId: req.organizationId!,
      to: seller.phone,
      content: req.body.content,
      sellerId: seller.id,
      role: 'OWNER',
      sentById: req.user!.sub,
      isAiGenerated: false,
    }, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
    });

    res.json({ ok: true, queued: true });
  })
);

// ─────────────────────────────────────────────────────────
// SEND CONTRACT NOTIFICATION
// ─────────────────────────────────────────────────────────

router.post('/:id/contract',
  requireManager,
  param('id').isString().trim(),
  body('deliveryMethod').isIn(['sms', 'email', 'both']),
  body('contractNotes').optional().isString().trim().isLength({ max: 500 }),
  asyncHandler(async (req: Request, res: Response) => {
    const seller = await prisma.sellerLead.findFirst({
      where: { id: req.params.id, organizationId: req.organizationId! },
      include: { contract: true },
    });
    if (!seller) throw new ApiError(404, 'Seller not found');
    if (seller.status !== SellerStatus.AGREED) {
      throw new ApiError(409, 'Seller must be in AGREED status before sending contract');
    }

    const { deliveryMethod } = req.body;
    const methodLabel = {
      sms: 'SMS',
      email: 'email',
      both: 'SMS and email',
    }[deliveryMethod];

    const fname = seller.name.split(' ')[0] || 'there';
    const msg = `Wonderful news, ${fname}! Your purchase agreement is being sent via ${methodLabel} now. `
      + `Please review, sign, and return at your convenience — don't hesitate to reach out with any questions. `
      + `We're here every step of the way and look forward to a smooth closing!`;

    await smsQueue.add('send-sms', {
      organizationId: req.organizationId!,
      to: seller.phone,
      content: msg,
      sellerId: seller.id,
      role: 'AI',
      isAiGenerated: false,
    });

    await prisma.sellerLead.update({
      where: { id: seller.id },
      data: { contractSent: true, contractSentAt: new Date() },
    });

    await audit.create({
      organizationId: req.organizationId!,
      userId: req.user!.sub,
      action: 'CONTRACT_SENT',
      entityType: 'seller_lead',
      entityId: seller.id,
      meta: { deliveryMethod },
      ip: req.ip,
    });

    res.json({ ok: true });
  })
);

// ─────────────────────────────────────────────────────────
// BULK ACTIONS
// ─────────────────────────────────────────────────────────

router.post('/bulk',
  requireManager,
  body('ids').isArray({ min: 1, max: 500 }),
  body('action').isIn(['remove', 'pause', 'resume', 'assign', 'tag']),
  body('ownerId').optional().isString(),
  body('tagId').optional().isString(),
  asyncHandler(async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) throw new ApiError(400, 'Validation failed');

    const { ids, action, ownerId, tagId } = req.body;
    const orgId = req.organizationId!;

    // Verify all IDs belong to this org
    const count = await prisma.sellerLead.count({
      where: { id: { in: ids }, organizationId: orgId },
    });
    if (count !== ids.length) throw new ApiError(403, 'Some IDs do not belong to this organization');

    switch (action) {
      case 'remove':
        await prisma.sellerLead.updateMany({
          where: { id: { in: ids }, organizationId: orgId },
          data: { status: SellerStatus.LOST, aiPaused: true, removedAt: new Date() },
        });
        break;
      case 'pause':
        await prisma.sellerLead.updateMany({
          where: { id: { in: ids }, organizationId: orgId },
          data: { aiPaused: true },
        });
        break;
      case 'resume':
        await prisma.sellerLead.updateMany({
          where: { id: { in: ids }, organizationId: orgId },
          data: { aiPaused: false },
        });
        break;
      case 'assign':
        if (!ownerId) throw new ApiError(400, 'ownerId required for assign action');
        await prisma.sellerLead.updateMany({
          where: { id: { in: ids }, organizationId: orgId },
          data: { ownerId },
        });
        break;
      case 'tag':
        if (!tagId) throw new ApiError(400, 'tagId required for tag action');
        await prisma.tagOnSeller.createMany({
          data: ids.map((id: string) => ({ sellerId: id, tagId })),
          skipDuplicates: true,
        });
        break;
    }

    res.json({ ok: true, affected: ids.length });
  })
);

export default router;
