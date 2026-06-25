// src/routes/analytics.ts
import { Router, Request, Response } from 'express';
import { prisma } from '../utils/prisma';
import { authenticate, requireAny } from '../middleware/authenticate';
import { asyncHandler } from '../utils/errors';
import { cacheGet, cacheSet } from '../utils/redis';
import { query } from 'express-validator';

const router = Router();
router.use(authenticate);

// ─── Summary dashboard KPIs ────────────────────────────────────────────────

router.get('/summary',
  requireAny,
  asyncHandler(async (req: Request, res: Response) => {
    const orgId = req.organizationId!;
    const cacheKey = `analytics:summary:${orgId}`;

    const cached = await cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const [
      totalSellers, totalBuyers, totalContracts, totalAssignments,
      sellersByStatus, buyersByStatus,
      smsStats, recentActivity,
      avgDaysToContract,
    ] = await Promise.all([
      prisma.sellerLead.count({ where: { organizationId: orgId } }),
      prisma.buyerLead.count({ where: { organizationId: orgId } }),
      prisma.contract.count({ where: { organizationId: orgId } }),
      prisma.assignmentContract.count({ where: { organizationId: orgId, status: 'ASSIGNED' } }),

      prisma.sellerLead.groupBy({
        by: ['status'],
        where: { organizationId: orgId },
        _count: true,
      }),
      prisma.buyerLead.groupBy({
        by: ['status'],
        where: { organizationId: orgId },
        _count: true,
      }),

      prisma.smsStats.findUnique({ where: { organizationId: orgId } }),

      prisma.activity.findMany({
        where: { organizationId: orgId },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { text: true, color: true, createdAt: true },
      }),

      prisma.$queryRaw<[{ avg_days: number }]>`
        SELECT AVG(EXTRACT(EPOCH FROM (c."updatedAt" - sl."importedAt")) / 86400)::float AS avg_days
        FROM "Contract" c
        JOIN "SellerLead" sl ON sl.id = c."sellerId"
        WHERE c."organizationId" = ${orgId}
          AND c.status = 'SIGNED'
      `,
    ]);

    // Conversion rates
    const sellerStatusMap = Object.fromEntries(sellersByStatus.map(s => [s.status, s._count]));
    const buyerStatusMap  = Object.fromEntries(buyersByStatus.map(b => [b.status, b._count]));

    const warmSellers   = sellerStatusMap['WARM']        || 0;
    const agreedSellers = sellerStatusMap['AGREED']       || 0;
    const lostSellers   = sellerStatusMap['LOST']         || 0;
    const interestedBuyers = buyerStatusMap['INTERESTED'] || 0;
    const agreedBuyers    = buyerStatusMap['AGREED']      || 0;

    const contactRate     = totalSellers > 0 ? ((warmSellers + agreedSellers) / totalSellers * 100).toFixed(1) : '0';
    const sellerConvRate  = totalSellers > 0 ? (agreedSellers / totalSellers * 100).toFixed(1) : '0';
    const buyerConvRate   = totalBuyers  > 0 ? (agreedBuyers  / totalBuyers  * 100).toFixed(1) : '0';

    // Revenue estimation
    const agreedContracts = await prisma.contract.findMany({
      where: { organizationId: orgId, status: { in: ['SIGNED', 'SENT'] } },
      select: { purchasePrice: true, defaultFeeMin: true, defaultFeeMax: true },
    });
    const assignedContracts = await prisma.assignmentContract.findMany({
      where: { organizationId: orgId, status: { in: ['ASSIGNED', 'CLOSED'] } },
      select: { assignmentFee: true },
    });

    const totalPurchaseValue = agreedContracts.reduce((s, c) => s + c.purchasePrice, 0);
    const totalAssignmentRevenue = assignedContracts.reduce((s, a) => s + a.assignmentFee, 0);

    const result = {
      overview: {
        totalSellers,
        totalBuyers,
        totalContracts,
        totalAssignments,
        totalPurchaseValue,
        totalAssignmentRevenue,
      },
      rates: {
        contactRate:    parseFloat(contactRate),
        sellerConvRate: parseFloat(sellerConvRate),
        buyerConvRate:  parseFloat(buyerConvRate),
        avgDaysToContract: avgDaysToContract[0]?.avg_days ? parseFloat(avgDaysToContract[0].avg_days.toFixed(1)) : null,
      },
      sellerFunnel: {
        new:         sellerStatusMap['NEW']         || 0,
        warm:        warmSellers,
        negotiating: sellerStatusMap['NEGOTIATING'] || 0,
        agreed:      agreedSellers,
        lost:        lostSellers,
        cold:        sellerStatusMap['COLD']        || 0,
      },
      buyerFunnel: {
        new:         buyerStatusMap['NEW']         || 0,
        interested:  interestedBuyers,
        negotiating: buyerStatusMap['NEGOTIATING'] || 0,
        agreed:      agreedBuyers,
        cold:        buyerStatusMap['COLD']        || 0,
      },
      sms: {
        sent:      smsStats?.sent      || 0,
        received:  smsStats?.received  || 0,
        delivered: smsStats?.delivered || 0,
        failed:    smsStats?.failed    || 0,
        deliveryRate: smsStats?.sent
          ? ((smsStats.delivered / smsStats.sent) * 100).toFixed(1) + '%'
          : 'N/A',
      },
      recentActivity,
    };

    await cacheSet(cacheKey, result, 300); // 5-minute cache
    res.json(result);
  })
);

// ─── Revenue over time ─────────────────────────────────────────────────────

router.get('/revenue',
  requireAny,
  query('period').optional().isIn(['7d', '30d', '90d', '1y']),
  asyncHandler(async (req: Request, res: Response) => {
    const orgId  = req.organizationId!;
    const period = (req.query.period as string) || '30d';
    const days   = { '7d': 7, '30d': 30, '90d': 90, '1y': 365 }[period] || 30;
    const since  = new Date(Date.now() - days * 86_400_000);

    const cacheKey = `analytics:revenue:${orgId}:${period}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const daily = await prisma.$queryRaw<Array<{ date: string; revenue: number; count: number }>>`
      SELECT
        DATE("signedAt")::text AS date,
        SUM("assignmentFee")::int AS revenue,
        COUNT(*)::int AS count
      FROM "AssignmentContract"
      WHERE "organizationId" = ${orgId}
        AND "signedAt" >= ${since}
        AND status IN ('ASSIGNED', 'CLOSED')
      GROUP BY DATE("signedAt")
      ORDER BY date ASC
    `;

    const result = { period, data: daily };
    await cacheSet(cacheKey, result, 600);
    res.json(result);
  })
);

// ─── Lead source ROI ───────────────────────────────────────────────────────

router.get('/lead-sources',
  requireAny,
  asyncHandler(async (req: Request, res: Response) => {
    const orgId = req.organizationId!;

    const sources = await prisma.$queryRaw<Array<{
      source: string;
      total: number;
      agreed: number;
      contracted: number;
    }>>`
      SELECT
        COALESCE(sl.source, 'unknown') AS source,
        COUNT(*)::int AS total,
        COUNT(CASE WHEN sl.status = 'AGREED' THEN 1 END)::int AS agreed,
        COUNT(CASE WHEN c.id IS NOT NULL THEN 1 END)::int AS contracted
      FROM "SellerLead" sl
      LEFT JOIN "Contract" c ON c."sellerId" = sl.id
      WHERE sl."organizationId" = ${orgId}
      GROUP BY sl.source
      ORDER BY total DESC
    `;

    res.json({ sources });
  })
);

export default router;
