// src/services/email.ts
import nodemailer from 'nodemailer';
import { env } from '../config/env';
import { logger } from '../utils/logger';

interface EmailOptions {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
}

function createTransporter() {
  if (env.SENDGRID_API_KEY) {
    return nodemailer.createTransport({
      host: 'smtp.sendgrid.net',
      port: 587,
      auth: { user: 'apikey', pass: env.SENDGRID_API_KEY },
    });
  }

  if (env.SMTP_HOST) {
    return nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    });
  }

  // Dev fallback — logs to console, no actual send
  logger.warn('No email transport configured — emails will be logged only');
  return null;
}

let _transporter: ReturnType<typeof nodemailer.createTransport> | null = null;

function getTransporter() {
  if (!_transporter) _transporter = createTransporter();
  return _transporter;
}

export async function sendEmail(options: EmailOptions): Promise<void> {
  const transporter = getTransporter();

  if (!transporter) {
    logger.info({ to: options.to, subject: options.subject }, '[EMAIL DEV] Would send email');
    return;
  }

  const from = env.EMAIL_FROM || 'noreply@dealflowai.com';

  await transporter.sendMail({
    from,
    to: Array.isArray(options.to) ? options.to.join(', ') : options.to,
    subject: options.subject,
    html: options.html,
    text: options.text || options.html.replace(/<[^>]+>/g, ''),
    replyTo: options.replyTo,
  });

  logger.debug({ to: options.to, subject: options.subject }, 'Email sent');
}

// ─── Email templates ───────────────────────────────────────────────────────

export function emailTemplate(title: string, body: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f6f7f9; margin: 0; padding: 32px 16px;">
  <div style="max-width: 480px; margin: 0 auto; background: #fff; border-radius: 8px; padding: 40px 32px; box-shadow: 0 1px 3px rgba(0,0,0,.08);">
    <div style="margin-bottom: 24px;">
      <span style="font-weight: 700; font-size: 18px; color: #6c63ff;">DealFlow AI</span>
    </div>
    <h1 style="color: #1a1a2e; font-size: 22px; font-weight: 600; margin: 0 0 16px;">${title}</h1>
    ${body}
    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 32px 0 16px;">
    <p style="color: #9ca3af; font-size: 12px; margin: 0;">
      DealFlow AI &mdash; Real Estate Wholesale Platform<br>
      If you didn't request this email, you can safely ignore it.
    </p>
  </div>
</body>
</html>`;
}
