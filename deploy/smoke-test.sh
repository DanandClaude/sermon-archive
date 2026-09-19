#!/bin/sh
# Builds and starts the whole stack on this computer with throwaway services, checks that it works,
# takes a database backup, restores it into a blank database, and tears everything down.
#   deploy/smoke-test.sh          (needs Docker; takes several minutes the first time)
set -eu
cd "$(dirname "$0")"

ENVFILE=.env.smoke
cat > "$ENVFILE" <<ENV
DOMAIN=localhost
SITE_ADDRESS=:80
POSTGRES_PASSWORD=smoke-postgres-password
SECRETS_KEY=$(openssl rand -hex 32)
SMTP_URL=smtp://mailpit:1025
MAIL_FROM="Sermon Archive <archive@example.test>"
S3_BUCKET=sermon-archive-smoke
S3_REGION=us-east-1
S3_ENDPOINT=http://minio:9000
AWS_ACCESS_KEY_ID=minioadmin
AWS_SECRET_ACCESS_KEY=minioadmin
GOOGLE_CLIENT_ID=smoke-client-id
GOOGLE_CLIENT_SECRET=smoke-client-secret
ANALYZER=anthropic
ANTHROPIC_API_KEY=smoke-not-a-real-key
BACKUP_PASSPHRASE=smoke test passphrase
TZ=UTC
ENV
DC="docker compose -p sermon-smoke -f compose.yaml -f compose.smoke.yaml --env-file $ENVFILE"
cleanup() { $DC down -v --remove-orphans >/dev/null 2>&1 || true; rm -f "$ENVFILE"; }
trap cleanup EXIT

step() { printf '\n== %s\n' "$1"; }
fail() { printf 'FAILED: %s\n' "$1" >&2; $DC logs --tail=40 >&2 || true; exit 1; }

step "Building and starting"
$DC up -d --build --wait --wait-timeout 300 || fail "the stack did not become healthy"

step "The site answers through the web server"
[ "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8080/api/health)" = 200 ] || fail "/api/health"
curl -s http://localhost:8080/api/health | grep -q '"status":"ok"' || fail "health body"
[ "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8080/sign-in)" = 200 ] || fail "/sign-in"
[ "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8080/library)" = 307 ] || fail "signed-out /library should redirect to sign in"
echo ok

step "Migrations are safe to run again"
$DC run --rm migrate | grep -q "up to date" || fail "second migration run"
echo ok

step "Creating the first admin"
$DC exec -T web node dist/create-admin.mjs --email pastor@example.test --name "Test Pastor" | grep -q "sign-in/verify?token=" || fail "create-admin"
echo ok

step "The worker starts and checks in"
i=0; until $DC exec -T postgres psql -U sermon -d sermon_archive -tAc "select count(*) from worker_heartbeats" | grep -q '^[1-9]'; do
  i=$((i+1)); [ $i -lt 30 ] || fail "the worker never checked in"; sleep 2
done
echo ok

step "Backing up the database, then restoring it into a blank one"
$DC exec -T backup python -m sermon_worker.backup run | grep -q "'ok': True" || fail "backup run"
$DC exec -T backup python -m sermon_worker.backup list | grep -q "db-backups/daily/" || fail "backup list"
$DC exec -T postgres psql -U sermon -d postgres -c "create database restored" >/dev/null
$DC exec -T backup python -m sermon_worker.backup restore latest --into "postgres://sermon:smoke-postgres-password@postgres:5432/restored" | grep -q Restored || fail "restore"
[ "$($DC exec -T postgres psql -U sermon -d restored -tAc "select email from users")" = "pastor@example.test" ] || fail "restored data"
echo ok

step "Everything passed"
