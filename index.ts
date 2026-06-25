// src/index.ts
import './config/env'; // validate env first, before anything else
import { env } from './config/env';
import * as Sentry from '@sentry/node';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import morgan from 'morgan';
import { createServer } from 'http';

import { logger } from './utils/logger';
import { prisma } from './utils/prisma';
import { redis } from './utils/redis';
import { rateLimiter, authRateLimiter, webhookRateLimiter } from './middleware/rateLimiter';
import { errorHandler } from './middleware/errorHandler';
import { requestId } from './middleware/requestId';
import { organizationContext } from './middleware/organizationContext';

import authRouter from './routes/auth';
import organizationRouter from './routes/organizations';
import campaignRouter from './routes/campaigns';
import sellerRouter from './routes/sellers';
import buyerRouter from './routes/buyers';
import contractRouter from './routes/contracts';
import assignmentRouter from './routes/assignments';
import messageRouter from './routes/messages';
import negotiationRouter from './routes/negotiations';
import analyticsRouter from './routes/analytics';
import notificationRouter from './routes/notifications';
import taskRouter from './routes/tasks';
import settingsRouter from './routes/settings';
import webhookRouter from './routes/webhooks';
import healthRouter from './routes/health';

import { startWorkers } from './workers';

// ─────────────────────────────────────────────────────────
// SENTRY — must initialize before routes
// ─────────────────────────────────────────────────────────
if (env.SENTRY_DSN) {
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    integrations: [
      new Sentry.Integrations.Http({ tracing: true }),
      new Sentry.Integrations.Express({ app: express() }),
    ],
    tracesSampleRate: env.NODE_ENV === 'production' ? 0.1 : 1.0,
  });
}

// ─────────────────────────────────────────────────────────
// EXPRESS APP
// ─────────────────────────────────────────────────────────
const app = express();

// Sentry request handler (must be first)
if (env.SENTRY_DSN) {
  app.use(Sentry.Handlers.requestHandler());
  app.use(Sentry.Handlers.tracingHandler());
}

// Trust proxy (for rate limiting behind load balancer / Nginx)
app.set('trust proxy', 1);

// ─── Security ───
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'"],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false, // Allow embedding PDF previews
}));

// ─── CORS ───
const allowedOrigins = env.CORS_ORIGIN.split(',').map(o => o.trim());
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, Postman)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`Origin ${origin} not allowed by CORS`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID', 'X-Organization-ID'],
}));

// ─── Body parsing ───
// Note: Twilio webhooks need raw body for signature verification — handled in webhook router
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: false, limit: '10mb' }));
app.use(compression());

// ─── Logging ───
app.use(morgan('combined', {
  stream: { write: (message) => logger.info(message.trim()) },
  skip: (req) => req.url === '/health', // don't log health checks
}));

// ─── Request ID (for distributed tracing) ───
app.use(requestId);

// ─── Public routes (no auth required) ───
app.use('/health', healthRouter);
app.use('/api/auth', authRateLimiter, authRouter);
app.use('/api/webhooks', webhookRateLimiter, webhookRouter);

// ─── Rate limit all other API routes ───
app.use('/api', rateLimiter);

// ─── Authenticated routes ───
app.use('/api/organizations', organizationContext, organizationRouter);
app.use('/api/campaigns', organizationContext, campaignRouter);
app.use('/api/sellers', organizationContext, sellerRouter);
app.use('/api/buyers', organizationContext, buyerRouter);
app.use('/api/contracts', organizationContext, contractRouter);
app.use('/api/assignments', organizationContext, assignmentRouter);
app.use('/api/messages', organizationContext, messageRouter);
app.use('/api/negotiations', organizationContext, negotiationRouter);
app.use('/api/analytics', organizationContext, analyticsRouter);
app.use('/api/notifications', organizationContext, notificationRouter);
app.use('/api/tasks', organizationContext, taskRouter);
app.use('/api/settings', organizationContext, settingsRouter);

// ─── 404 handler ───
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found', path: req.path });
});

// ─── Sentry error handler ───
if (env.SENTRY_DSN) {
  app.use(Sentry.Handlers.errorHandler());
}

// ─── Global error handler (must be last) ───
app.use(errorHandler);

// ─────────────────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────────────────
const server = createServer(app);

async function start() {
  // Verify database connection
  try {
    await prisma.$connect();
    logger.info('✅ Database connected');
  } catch (err) {
    logger.error({ err }, '❌ Database connection failed');
    process.exit(1);
  }

  // Verify Redis connection
  try {
    await redis.ping();
    logger.info('✅ Redis connected');
  } catch (err) {
    logger.error({ err }, '❌ Redis connection failed');
    process.exit(1);
  }

  // Start BullMQ workers
  await startWorkers();
  logger.info('✅ Background workers started');

  server.listen(env.PORT, () => {
    logger.info(`
╔════════════════════════════════════════════════════╗
║        DealFlow AI — Backend Server  v3.0          ║
╚════════════════════════════════════════════════════╝
  Port    : ${env.PORT}
  Env     : ${env.NODE_ENV}
  DB      : Connected
  Redis   : Connected
  Workers : Running
════════════════════════════════════════════════════`);
  });
}

// ─────────────────────────────────────────────────────────
// GRACEFUL SHUTDOWN
// ─────────────────────────────────────────────────────────
async function shutdown(signal: string) {
  logger.info(`Received ${signal} — shutting down gracefully`);

  server.close(async () => {
    try {
      await prisma.$disconnect();
      await redis.quit();
      logger.info('Graceful shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
  });

  // Force exit after 30s
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 30_000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  logger.error({ err }, 'Uncaught exception');
  if (env.SENTRY_DSN) Sentry.captureException(err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled rejection');
  if (env.SENTRY_DSN) Sentry.captureException(reason);
  process.exit(1);
});

start().catch((err) => {
  logger.error({ err }, 'Failed to start server');
  process.exit(1);
});

export { app };
