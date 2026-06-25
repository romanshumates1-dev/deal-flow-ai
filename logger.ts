// src/utils/logger.ts
import pino from 'pino';

const isDev = process.env.NODE_ENV !== 'production';

export const logger = pino({
  level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
  transport: isDev
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' } }
    : undefined,
  formatters: {
    level: (label) => ({ level: label }),
  },
  // Never log PII in production
  redact: {
    paths: [
      'phone', 'email', 'passwordHash', 'password',
      'req.headers.authorization', 'mfaSecret', 'twilioToken',
      'anthropicKey', '*.passwordHash', '*.mfaSecret',
    ],
    censor: '[REDACTED]',
  },
  serializers: {
    err: pino.stdSerializers.err,
    req: pino.stdSerializers.req,
    res: pino.stdSerializers.res,
  },
});
