# DealFlow AI

AI-powered wholesale real estate deal management platform. Automates seller/buyer outreach via SMS, runs AI negotiations, tracks contracts and assignments, and provides a full CRM for acquisition and disposition teams.

---

## Stack

- **Runtime**: Node.js 20, TypeScript, Express
- **Database**: PostgreSQL 15
- **Cache / Queue**: Redis 7, BullMQ
- **AI**: Anthropic Claude (`@anthropic-ai/sdk`)
- **SMS**: Twilio
- **Documents**: PDFKit, DocuSign
- **Storage**: AWS S3
- **ORM**: Prisma 5
- **Observability**: Pino, Sentry

---

## Quick Start (Docker — Production)

```bash
git clone https://github.com/romanshumates1-dev/deal-flow-ai.git
cd deal-flow-ai
cp .env.example .env
# Fill in all values in .env
docker compose up -d
```

The API will be available at `http://localhost/api` (via nginx reverse proxy on port 80).

Check health:
```bash
curl http://localhost/health
```

---

## Local Development Setup

### Prerequisites

- Node.js 20+
- PostgreSQL 15 running locally
- Redis 7 running locally

### Install

```bash
npm install
cp .env.example .env
# Edit .env with your local values
```

### Database bootstrap (first time only)

```bash
# Apply raw SQL schema (extensions, partitions, triggers, views)
psql "$DATABASE_URL" -f scripts/001_initial_schema.sql

# Tell Prisma the DB is already migrated at baseline
mkdir -p prisma/migrations/0001_initial
touch prisma/migrations/0001_initial/migration.sql
npx prisma migrate resolve --applied "0001_initial"

# Apply Phase 2 additive migration
npx prisma migrate deploy

# Generate Prisma client
npx prisma generate

# Seed development data
npx prisma db seed
```

### Run

```bash
# API server (hot reload)
npm run dev

# Workers run inside the same process in dev (startWorkers() is called from index.ts)
```

---

## Prisma Migration Steps (ordered, production)

```bash
# 1. Validate schema
npx prisma validate

# 2. Generate client
npx prisma generate

# 3. Check pending
npx prisma migrate status

# 4. Apply (production — no prompts, no shadow DB)
npx prisma migrate deploy
```

> Never run `prisma migrate dev` against production. Use `migrate deploy` only.

---

## Environment Variables

See `.env.example` for all required values. No variable is optional in production.

---

## Deployment Checklist

- [ ] All `.env` values set (no placeholders remaining)
- [ ] `DATABASE_URL` points to production Postgres with SSL (`?sslmode=require`)
- [ ] `REDIS_URL` points to production Redis with AUTH password
- [ ] `JWT_SECRET` is minimum 64 random characters
- [ ] `ENCRYPTION_KEY` is exactly 32 bytes hex (64 hex chars) — used for AES-256-GCM
- [ ] Twilio phone number verified and SMS-capable
- [ ] Anthropic API key active and has sufficient quota
- [ ] S3 bucket created with correct IAM policy (PutObject, GetObject, DeleteObject)
- [ ] `CORS_ORIGIN` set to your frontend domain only
- [ ] `NODE_ENV=production`
- [ ] `SENTRY_DSN` set if using Sentry
- [ ] `scripts/001_initial_schema.sql` applied once on fresh DB
- [ ] `npx prisma migrate deploy` run before starting containers
- [ ] `npx prisma generate` run as part of Docker build
- [ ] Docker healthcheck passes: `curl -f http://localhost:3000/health`
- [ ] Nginx SSL termination configured (certbot or load balancer)
- [ ] DB snapshot taken before every future migration

---

## Health Check Endpoints