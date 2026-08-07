#!/usr/bin/env bash
# Launch the Guardian web app (TanStack Start + nitro) for local driving.
#
# Runs BOT-LESS by design: the root .env may carry a real TELEGRAM_BOT_TOKEN and
# EVENT_WATCH settings, but a headless run wants neither a Telegram long-poll nor
# an event watcher hammering RPC. We blank those three vars in the launch env so
# the server comes up as "the HTTP dashboard only" (see bootstrap.server.ts).
#
# The web app's server functions read GUARDIAN_MASTER_KEY + REDIS_URL from
# process.env via dotenv/config — but dotenv resolves .env from CWD (web/), which
# has no .env. So we source the repo-root .env into the env here before launch.
#
# Usage:  .claude/skills/run-liquidation-guardian/serve.sh
# Serves: http://localhost:3000  (logs -> /tmp/guardian-web.log)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO_ROOT"

# 1. Redis (the credential + watch store). Idempotent.
if ! redis-cli ping >/dev/null 2>&1; then
  redis-server --daemonize yes --save '' --appendonly no >/tmp/redis.log 2>&1
  sleep 1
fi
redis-cli ping >/dev/null && echo "redis: up"

# 2. Source root .env so the nitro server sees GUARDIAN_MASTER_KEY, REDIS_URL,
#    KEEPERHUB_API_KEY, LLM_*, etc. (values here have no spaces).
if [ -f .env ]; then set -a; . ./.env; set +a; fi

# 3. Bot-less + watcher-off overrides (these win because dotenv/config inside the
#    app does NOT override already-set process.env vars).
export TELEGRAM_BOT_TOKEN=""
export EVENT_WATCH_ENABLED="false"
export WEBAPP_URL=""

# 4. Launch vite dev (nitro server on :3000). Foreground — caller backgrounds it.
cd web
echo "starting vite dev on http://localhost:3000 ..."
exec npm run dev
