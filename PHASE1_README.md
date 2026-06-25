# DealFlow AI — Phase 1: Docker Production Architecture
## Audit Report + Deployment Guide

---

## 0. Audit Summary (Repo: romanshumates1-dev/deal-flow-ai)

Files audited: `package.json`, `schema.prisma`, `index.ts`, `redis.ts`, `queues.ts`, `env.ts`, `auth.ts`

### What Already Exists and Works (PRESERVE)

| Module | Status | Notes |
|--------|--------|-------|
| `src/index.ts` | ✅ Well-built | Helmet, CORS, morgan, Sentry, graceful shutdown — keep as-is |
| `src/config/env.ts` | ✅ Solid | Zod validation, fails fast — no changes needed |
| `src/utils/redis.ts` | ✅ Good | cacheGet/cacheSet/cacheInvalidate helpers — preserve |
| `src/routes/auth.ts` | ✅ Solid | bcrypt, JWT rotate, MFA, lockout, denylist — well done |
| `schema.prisma` | ✅ Excellent | 812 lines, 20+ models, proper indexes — no redesign needed |
| `src/workers/queues.ts` | ⚠️ Bug | See C1 below |
| `src/routes/auth.ts` | ⚠️ Bug | See C2 below — MFA field name mismatch |
| `package.json` prisma path | ⚠️ Bug | See C3 below |
| `server.js` (root) | 🗑️ Legacy | Old monolith JS entry point — superseded by `src/index.ts` v3 |

---

## 1. Confirmed Issues (from actual code — not theoretical)

### C1 — BullMQ Redis Connection (queues.ts, line 6) — BREAKING
**File:** `queues.ts`
**Code found:**
```typescript
const connection = { host: redis.options.host, port: redis.options.port };
```
**Problem:** When `REDIS_URL` includes a password (`redis://:password@host:6379`), ioredis
parses it internally. Extracting only `.options.host` and `.options.port` creates a
connection object with NO password — BullMQ queues will fail silently or refuse to connect
in any secured Redis environment (all production deployments).

**Fix (in `src/workers/queues.ts`):**
```typescript
const connection = { url: process.env.REDIS_URL || 'redis://localhost:6379' };
```
Fixed version provided at: `src/workers/queues.ts` in this deliverable.

---

### C2 — MFA Field Name Mismatch (auth.ts ↔ schema.prisma) — BREAKING
**Files:** `auth.ts` (lines ~295, 525, 528, 539) and `schema.prisma` (line ~274)

**schema.prisma defines:**
```prisma
mfaSecret String? // TOTP secret, encrypted
```
**auth.ts references:**
```typescript
user.mfaSecretEnc
data: { mfaSecretEnc: encryptField(secret) }
```
**Problem:** Prisma will throw `Unknown field: mfaSecretEnc` at runtime on any MFA operation.
All MFA setup, confirm, and disable endpoints will fail for all users.

**Fix:** Rename `mfaSecret` → `mfaSecretEnc` in schema.prisma + create migration.
See `src/fixes/mfa_field_mismatch.notes.ts` for full migration SQL.

---

### C3 — Prisma Schema Path Mismatch (package.json) — BUILD BREAKING
**File:** `package.json`
```json
"prisma": {
  "schema": "../database/prisma/schema.prisma"
}
```
**Problem:** `schema.prisma` exists at repository root, not at `../database/prisma/schema.prisma`.
`npx prisma generate` and `npx prisma migrate` will fail because the path doesn't exist.

**Fix:** Update `package.json`:
```json
"prisma": {
  "schema": "./schema.prisma"
}
```
Or restructure to `prisma/schema.prisma` (preferred for Prisma CLI conventions).

---

### C4 — No `src/` Directory Structure in Repo — STRUCTURAL
**Problem:** `index.ts` imports from `./config/env`, `./utils/logger`, `./routes/auth`, etc.
but the repo root only contains flat files. The actual source directory (`src/`) is missing
from the repository (likely in `.gitignore` or not yet committed).

**Impact:** The Docker build (which runs `tsc` compiling `src/**`) will fail until the full
`src/` directory is present.

**Action required:** Ensure your local `src/` directory is committed to the repo before
running the Docker build.

---

## 2. Confirmed Non-Issues (cleared after audit)

| Item | Decision |
|------|----------|
| Auth lockout logic | ✅ Correct — bcrypt compare, progressive lockout, enum-safe unlock |
| JWT denylist | ✅ Correct — Redis `denylist:TOKEN` with TTL matching expiry |
| Refresh token rotation | ✅ Correct — old token revoked, new issued, SHA-256 hash stored |
| CORS config | ✅ Correct — origin whitelist with `credentials: true` |
| Helmet CSP | ✅ Solid baseline — `frameSrc: none`, `objectSrc: none` |
| Redis retry strategy | ✅ Correct — exponential backoff, stops at 10 attempts |
| Prisma singleton | ✅ Fine for production containers (no HMR in Docker) |
| BullMQ queue separation | ✅ Deliberate — AI queue isolated from SMS to prevent starvation |

---

## 3. Docker Architecture

### Service Map

```
Internet
    │
    ▼
  nginx (80/443)
    │  Static: dealflow_ai_platform.html
    │  /api/* → proxy
    │  /health → proxy (no rate limit)
    │
    ▼
  api (port 3001, internal only)
    │  Express + TypeScript (src/index.ts)
    │  All routes: auth, sellers, buyers, contracts, etc.
    │  Sentry, helmet, rate limiting, CORS
    │
    ├──→ postgres (internal)
    │      PostgreSQL 16-alpine
    │      connection_limit=20 (Prisma pool)
    │
    └──→ redis (internal, password-protected)
           BullMQ queues + cache

  worker (internal only)
    │  aiWorker + smsWorker + followUpWorker
    │  Shares postgres + redis with API
    │  NO HTTP listener (queue consumer only)
    │
    ├──→ postgres (connection_limit=10)
    └──→ redis
```

### File Structure (what this deliverable creates)

```
your-repo/
├── docker-compose.yml              ← Main compose file
├── .env.production                 ← Fill in secrets (NEVER commit)
├── tsconfig.json                   ← Updated for Docker build paths
├── docker/
│   ├── Dockerfile.api              ← Multi-stage: deps → builder → production
│   ├── postgres/
│   │   └── init/
│   │       └── 01_extensions.sql  ← pg_trgm, uuid-ossp
│   └── nginx/
│       ├── nginx.conf              ← Worker processes, gzip, logging
│       └── conf.d/
│           ├── dealflow.conf       ← HTTP→HTTPS redirect, proxy, rate limiting
│           └── proxy_params.conf   ← Shared proxy headers
├── frontend/
│   └── dealflow_ai_platform.html  ← Copy your existing HTML here
├── scripts/
│   └── deploy.sh                  ← first-deploy / update / rollback / health
└── src/
    ├── workers/
    │   ├── index.ts                ← New: worker container entrypoint
    │   └── queues.ts               ← Fixed: BullMQ connection bug (C1)
    └── fixes/
        └── mfa_field_mismatch.notes.ts  ← C2 fix instructions
```

---

## 4. Old → New Service Equivalence

| Old (current) | New (Docker) | Notes |
|---------------|-------------|-------|
| `node server.js` | `api` container, `dist/index.js` | server.js is legacy JS; index.ts is v3 |
| Manual Redis | `redis` container | Password protected, persistence enabled |
| Manual Postgres | `postgres` container | Optimized settings, health checks |
| Workers in-process | `worker` container | Separate container, same codebase |
| No reverse proxy | `nginx` container | TLS, rate limiting, static serving |

---

## 5. Migration Steps (from current state to Docker)

### Step 1: Fix confirmed bugs first

```bash
# C3 fix — update package.json prisma path
# Change: "../database/prisma/schema.prisma"
# To:     "./schema.prisma"

# C1 fix — replace queues.ts connection line
# Use the fixed src/workers/queues.ts from this deliverable

# C2 fix — rename mfaSecret → mfaSecretEnc in schema.prisma
# Run migration: ALTER TABLE "User" RENAME COLUMN "mfaSecret" TO "mfaSecretEnc";
```

### Step 2: Organize directory structure

```bash
# Ensure src/ is structured as index.ts expects:
mkdir -p src/{config,utils,routes,middleware,services,workers}

# Move flat files from repo root into src/ subfolders:
mv env.ts        src/config/env.ts
mv logger.ts     src/utils/logger.ts
mv prisma.ts     src/utils/prisma.ts
mv redis.ts      src/utils/redis.ts
mv queues.ts     src/workers/queues.ts    # Use the fixed version
mv auth.ts       src/routes/auth.ts
mv sellers.ts    src/routes/sellers.ts
mv aiWorker.ts   src/aiWorker.ts
mv smsWorker.ts  src/smsWorker.ts
mv followUpWorker.ts src/followUpWorker.ts
# ... etc for all other files

# Frontend (single HTML file)
mkdir -p frontend
cp dealflow_ai_platform.html frontend/

# Prisma
mkdir -p prisma
cp schema.prisma prisma/schema.prisma
```

### Step 3: Fill in environment variables

```bash
cp .env.production .env.production.local
# Edit .env.production.local with real values:
# - POSTGRES_PASSWORD (openssl rand -hex 16)
# - REDIS_PASSWORD (openssl rand -hex 16)
# - JWT_SECRET (openssl rand -hex 32)
# - ENCRYPTION_KEY (openssl rand -hex 32)
# - All third-party API keys
```

### Step 4: Configure nginx domain

```bash
# Edit docker/nginx/conf.d/dealflow.conf
# Replace "YOUR_DOMAIN" with your actual domain (2 places)

# Add TLS certificates
mkdir -p docker/nginx/ssl
# Place fullchain.pem and privkey.pem in docker/nginx/ssl/
# (use certbot, acme.sh, or your certificate provider)
```

### Step 5: First deploy

```bash
chmod +x scripts/deploy.sh
./scripts/deploy.sh first-deploy

# Verify
./scripts/deploy.sh health
curl https://your-domain.com/health
```

---

## 6. Update Workflow (subsequent deploys)

```bash
# After code changes:
git pull origin main
./scripts/deploy.sh update

# Manual backup:
./scripts/deploy.sh backup

# Emergency rollback:
./scripts/deploy.sh rollback
```

---

## 7. Key Production Decisions

**Workers separate from API:** The three worker files (`aiWorker.ts`, `smsWorker.ts`,
`followUpWorker.ts`) run in their own container. This means an Anthropic API timeout
or Twilio error doesn't block your HTTP endpoints, and you can scale workers independently.

**Prisma connection pooling:** API gets `connection_limit=20`, worker gets `connection_limit=10`.
PostgreSQL is configured with `max_connections=100` — safe headroom for both plus admin connections.

**Redis persistence:** Both RDB snapshots and AOF enabled. BullMQ delayed jobs (follow-ups)
survive Redis restarts. This is important for the `followUpQueue` which stores scheduled
SMS follow-ups.

**Nginx rate limiting:** Three zones — auth (10 req/min), webhooks (30 req/min), general API
(60 req/min). Auth is tightest because your `auth.ts` already implements account lockout,
and the two layers together make brute force impractical.

**Internal network isolation:** `postgres` and `redis` containers have no external ports.
Only `nginx` has public ports. The `api` and `worker` containers can reach the databases,
but nothing outside Docker can.

---

## 8. Phase 2 Prerequisites (Prisma Migrations)

Before proceeding to Phase 2:
- [ ] C1 fixed: `queues.ts` connection string
- [ ] C2 fixed: `mfaSecretEnc` field in schema.prisma
- [ ] C3 fixed: `package.json` prisma schema path
- [ ] Docker layer is stable: `./scripts/deploy.sh health` returns healthy for all services
- [ ] `prisma migrate deploy` runs clean: `./scripts/deploy.sh migrate`

Phase 2 will cover: migration baseline from `001_initial_schema.sql`, Prisma migration
history initialization, seed data, and the `schema.prisma` v3 → production baseline migration.
