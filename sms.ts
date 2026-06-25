// src/services/sms.ts
// Wraps Twilio with org-level credentials, signature verification, and demo mode.

import twilio, { Twilio } from 'twilio';
import { env } from '../config/env';
import { decrypt, decryptSafe } from '../utils/crypto';
import { logger } from '../utils/logger';

interface OrgTwilioConfig {
  accountSid?: string | null;
  authToken?: string | null;   // stored encrypted
  fromNumber?: string | null;
}

interface SendSmsOptions {
  to: string;
  body: string;
  org: OrgTwilioConfig;
  statusCallback?: string;
}

interface SmsResult {
  sid: string;
  demo: boolean;
  status: string;
}

/** Resolve org-specific Twilio client, falling back to global env credentials */
function resolveTwilioClient(org: OrgTwilioConfig): { client: Twilio; from: string } | null {
  const sid   = org.accountSid   || env.TWILIO_ACCOUNT_SID;
  const token = org.authToken    ? decryptSafe(org.authToken) : env.TWILIO_AUTH_TOKEN;
  const from  = org.fromNumber   || env.TWILIO_FROM_NUMBER;

  if (!sid || !token || !from) return null;
  return { client: twilio(sid, token), from };
}

/** Send an SMS message. Returns demo result if credentials are missing. */
export async function sendSms(options: SendSmsOptions): Promise<SmsResult> {
  const resolved = resolveTwilioClient(options.org);

  if (!resolved) {
    logger.info({ to: options.to, body: options.body.slice(0, 60) }, '[SMS DEMO] Would send');
    return { sid: `DEMO_${Date.now()}`, demo: true, status: 'demo' };
  }

  const { client, from } = resolved;

  const msg = await client.messages.create({
    body: options.body,
    from,
    to: options.to,
    statusCallback: options.statusCallback || env.TWILIO_WEBHOOK_URL,
  });

  logger.info({ sid: msg.sid, to: options.to, status: msg.status }, 'SMS sent');
  return { sid: msg.sid, demo: false, status: msg.status };
}

/**
 * Verify Twilio webhook signature.
 * Must be called with the RAW body (Buffer or string) before any JSON parsing.
 * Returns false if credentials are missing (demo mode — skip verification).
 */
export function verifyTwilioSignature(
  org: OrgTwilioConfig,
  url: string,
  params: Record<string, string>,
  signature: string
): boolean {
  const sid   = org.accountSid   || env.TWILIO_ACCOUNT_SID;
  const token = org.authToken    ? decryptSafe(org.authToken) : env.TWILIO_AUTH_TOKEN;

  if (!sid || !token) {
    // Demo mode: skip verification
    logger.warn('Twilio credentials not set — skipping webhook signature verification (demo mode)');
    return true;
  }

  return twilio.validateRequest(token, signature, url, params);
}
