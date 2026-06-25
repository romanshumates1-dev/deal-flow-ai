// src/utils/phone.ts
// US-centric phone normalization. E.164 output (+1XXXXXXXXXX).

/**
 * Normalizes a raw phone number to E.164 format.
 * Returns null if the number cannot be normalized to a valid US number.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');

  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits[0] === '1') return `+${digits}`;

  // International — return as-is if it looks plausible
  if (digits.length >= 7 && digits.length <= 15) return `+${digits}`;

  return null;
}

/**
 * Formats a normalized E.164 number for display: +1 (XXX) XXX-XXXX
 */
export function formatPhone(e164: string): string {
  const d = e164.replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') {
    return `+1 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  }
  if (d.length === 10) {
    return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  }
  return e164;
}

/** Returns true if the message body is a TCPA opt-out keyword */
export function isOptOutKeyword(body: string): boolean {
  const normalized = body.trim().toUpperCase().replace(/[^A-Z\s]/g, '').trim();
  const OPT_OUT = new Set([
    'STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT',
    'STOP ALL', 'OPT OUT', 'OPTOUT', 'DO NOT CONTACT', 'REMOVE',
    'REMOVE ME', 'TAKE ME OFF', 'NO MORE', 'DONT CONTACT',
  ]);
  return OPT_OUT.has(normalized);
}

/** Returns true if the message is an opt-in/help keyword */
export function isOptInKeyword(body: string): boolean {
  const normalized = body.trim().toUpperCase().replace(/[^A-Z\s]/g, '').trim();
  return new Set(['START', 'YES', 'UNSTOP', 'SUBSCRIBE', 'HELP']).has(normalized);
}
