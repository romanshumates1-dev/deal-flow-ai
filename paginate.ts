// src/utils/paginate.ts

export interface PaginatedResult<T> {
  data: T[];
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}

export function paginate<T>(
  data: T[],
  page: number,
  limit: number,
  total: number
): PaginatedResult<T> {
  const totalPages = Math.ceil(total / limit);
  return {
    data,
    meta: {
      page,
      limit,
      total,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    },
  };
}

/** Build Prisma skip/take from page + limit */
export function buildPrismaPage(page = 1, limit = 50): { skip: number; take: number } {
  const safePage  = Math.max(1, page);
  const safeLimit = Math.min(200, Math.max(1, limit));
  return { skip: (safePage - 1) * safeLimit, take: safeLimit };
}
