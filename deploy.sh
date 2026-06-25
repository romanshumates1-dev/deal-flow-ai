#!/bin/bash
# ============================================================
# DealFlow AI — Production Deploy Script
# Usage: ./scripts/deploy.sh [first-deploy|update|rollback]
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$PROJECT_DIR/docker-compose.yml"
ENV_FILE="$PROJECT_DIR/.env.production"
BACKUP_DIR="$PROJECT_DIR/backups"

# ─── Helpers ──────────────────────────────────────────────
log()  { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
fail() { echo "[ERROR] $*" >&2; exit 1; }

check_prereqs() {
  command -v docker        &>/dev/null || fail "docker not found"
  command -v docker-compose &>/dev/null || command -v docker &>/dev/null || fail "docker compose not found"
  [[ -f "$ENV_FILE" ]]      || fail ".env.production not found at $ENV_FILE"
  [[ -f "$COMPOSE_FILE" ]]  || fail "docker-compose.yml not found"
}

# ─── Database backup ──────────────────────────────────────
backup_db() {
  log "Backing up database..."
  mkdir -p "$BACKUP_DIR"
  BACKUP_FILE="$BACKUP_DIR/dealflow_$(date '+%Y%m%d_%H%M%S').sql.gz"
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" \
    exec -T postgres \
    pg_dump -U "${POSTGRES_USER:-dealflow}" "${POSTGRES_DB:-dealflow}" \
    | gzip > "$BACKUP_FILE"
  log "Backup saved: $BACKUP_FILE"
}

# ─── Run Prisma migrations ────────────────────────────────
run_migrations() {
  log "Running Prisma migrations..."
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" \
    run --rm api \
    npx prisma migrate deploy
  log "Migrations complete"
}

# ─── First deploy ─────────────────────────────────────────
first_deploy() {
  log "=== FIRST DEPLOY ==="
  check_prereqs

  # Pull latest images
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" pull postgres redis

  # Build API/Worker images
  log "Building application images..."
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" build --no-cache api worker

  # Start infrastructure first
  log "Starting infrastructure (postgres, redis)..."
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" \
    up -d postgres redis

  # Wait for healthy
  log "Waiting for postgres to be healthy..."
  for i in {1..30}; do
    docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" \
      exec postgres pg_isready -U "${POSTGRES_USER:-dealflow}" &>/dev/null && break
    sleep 2
  done

  # Run migrations (first deploy — apply full schema)
  run_migrations

  # Start application
  log "Starting application services..."
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" \
    up -d api worker nginx

  log "=== First deploy complete ==="
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" ps
}

# ─── Update (zero-downtime rolling) ───────────────────────
update() {
  log "=== UPDATING APPLICATION ==="
  check_prereqs

  # Backup first
  backup_db

  # Build new images
  log "Building new images..."
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" build api worker

  # Run migrations before switching (backward-compatible migrations only)
  run_migrations

  # Rolling restart — api first, then worker
  log "Rolling restart: API..."
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" \
    up -d --no-deps api
  sleep 5

  log "Rolling restart: Worker..."
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" \
    up -d --no-deps worker

  log "=== Update complete ==="
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" ps
}

# ─── Rollback ─────────────────────────────────────────────
rollback() {
  log "=== ROLLBACK ==="
  check_prereqs

  # List available backups
  log "Available backups:"
  ls -lt "$BACKUP_DIR"/*.sql.gz 2>/dev/null || fail "No backups found in $BACKUP_DIR"

  read -rp "Enter backup filename to restore (full path): " BACKUP_FILE
  [[ -f "$BACKUP_FILE" ]] || fail "Backup file not found: $BACKUP_FILE"

  log "WARNING: This will overwrite the current database. Ctrl+C to cancel."
  sleep 5

  # Stop app services (keep postgres + redis running)
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" stop api worker

  # Restore backup
  log "Restoring from $BACKUP_FILE..."
  gunzip -c "$BACKUP_FILE" | docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" \
    exec -T postgres \
    psql -U "${POSTGRES_USER:-dealflow}" "${POSTGRES_DB:-dealflow}"

  # Restart with previous image (assumes previous tag was saved)
  log "Restarting services..."
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d api worker

  log "=== Rollback complete ==="
}

# ─── Health check ─────────────────────────────────────────
check_health() {
  log "=== HEALTH CHECK ==="
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" ps
  echo ""
  log "API health:"
  curl -s http://localhost/health | python3 -m json.tool 2>/dev/null || echo "(nginx not yet responding)"
}

# ─── Entry point ──────────────────────────────────────────
case "${1:-help}" in
  first-deploy)  first_deploy ;;
  update)        update ;;
  rollback)      rollback ;;
  health)        check_health ;;
  backup)        check_prereqs; backup_db ;;
  migrate)       check_prereqs; run_migrations ;;
  *)
    echo "Usage: $0 {first-deploy|update|rollback|health|backup|migrate}"
    exit 1
    ;;
esac
