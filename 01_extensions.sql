-- ============================================================
-- DealFlow AI — PostgreSQL initialization
-- Runs once on first container start (empty volume).
-- schema.prisma uses cuid() — no extension needed.
-- But we add pg_trgm for future LIKE-index optimization.
-- ============================================================

-- Enable trigram extension for future full-text search on names/addresses
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Enable uuid-ossp as fallback (Prisma uses cuid but some raw queries may use uuid)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Confirm
SELECT 'DealFlow AI PostgreSQL initialization complete' AS status;
