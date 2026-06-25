// src/workers/smsWorker.ts
import { Worker, Job } from 'bullmq';
import { redis } from '../utils/redis';
import { prisma } from '../utils/prisma';
import { sendSms } from '../services/sms';
import { logger } from '../utils/logger';
import { MessageRole, MessageChannel } from '@prisma/client';

export interface SmsJobData {
  organizationId: string;
  to: string;
  content: string;
  sellerId?: string;
  buyerId?: string;
  role: MessageRole;
  sentById?: string;
  isAiGenerated: boolean;
  followUpId?: string;
}

export function createSmsWorker() {
  const worker = new Worker<SmsJobData>(
    'sms',
    async (job: Job<SmsJobData>) => {
      const { organizationId, to, content, sellerId, buyerId, role, sentById, isAiGenerated, followUpId } = job.data;

      // Load org credentials for Twilio
      const org = await prisma.organization.findUnique({
        where: { id: organizationId },
        select: { twilioSid: true, twilioToken: true, twilioFrom: true },
      });
      if (!org) throw new Error(`Organization ${organizationId} not found`);

      // Send SMS
      const result = await sendSms({
        to,
        body: content,
        org: { accountSid: org.twilioSid, authToken: org.twilioToken, fromNumber: org.twilioFrom },
      });

      // Persist message record
      const message = await prisma.message.create({
        data: {
          organizationId,
          sellerId:      sellerId || null,
          buyerId:       buyerId  || null,
          role,
          channel:       MessageChannel.SMS,
          content,
          isAiGenerated,
          sentById:      sentById || null,
          smsStatus:     result.demo ? 'demo' : 'sent',
          smsSid:        result.sid,
        },
      });

      // Update follow-up record if this was a scheduled follow-up
      if (followUpId) {
        await prisma.followUp.update({
          where: { id: followUpId },
          data: { status: 'SENT', sentAt: new Date() },
        });
      }

      // Update SMS stats for the org
      await prisma.smsStats.upsert({
        where: { organizationId },
        create: { organizationId, sent: 1 },
        update: { sent: { increment: 1 } },
      });

      logger.info({ sid: result.sid, to, demo: result.demo }, 'SMS job completed');
      return { messageId: message.id, sid: result.sid };
    },
    {
      connection: { host: redis.options.host, port: redis.options.port },
      concurrency: 5,    // 5 simultaneous SMS sends
      limiter: {
        max: 10,         // max 10 messages per second (Twilio default tier)
        duration: 1_000,
      },
    }
  );

  worker.on('completed', (job) => {
    logger.debug({ jobId: job.id }, 'SMS job completed');
  });

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err: err.message, attempts: job?.attemptsMade }, 'SMS job failed');

    // Update message status to failed if we can identify the message
    if (job?.data.sellerId || job?.data.buyerId) {
      prisma.smsStats.upsert({
        where: { organizationId: job.data.organizationId },
        create: { organizationId: job.data.organizationId, failed: 1 },
        update: { failed: { increment: 1 } },
      }).catch(() => {});
    }
  });

  return worker;
}
