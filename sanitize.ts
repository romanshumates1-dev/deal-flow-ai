// src/utils/sanitize.ts
// Input cleaning utilities. We sanitize at write-time, not read-time.

/**
 * Strip null bytes, trim, collapse internal whitespace, limit length.
 * Safe for plain-text fields (names, addresses, notes).
 */
export function sanitizeText(
  value: unknown,
  maxLength = 500
): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\0/g, '')         // null bytes
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // control chars (keep \n \r \t)
    .trim()
    .replace(/\s{2,}/g, ' ')   // collapse multiple spaces
    .slice(0, maxLength);
}

/**
 * Minimal HTML entity escaping for values that may end up in HTML output.
 * Prefer sanitizeText for DB fields; use this only when building HTML strings.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Strip all non-numeric characters from a currency string.
 * Returns null if the result is not a positive integer.
 */
export function parseMoney(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = parseInt(String(value).replace(/[^0-9-]/g, ''), 10);
  if (isNaN(n) || n < 0) return null;
  return n;
}

/**
 * Validate and parse a positive integer from unknown input.
 */
export function parsePositiveInt(value: unknown, max?: number): number | null {
  const n = parseInt(String(value), 10);
  if (isNaN(n) || n <= 0) return null;
  if (max !== undefined && n > max) return null;
  return n;
}
