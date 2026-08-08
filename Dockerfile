# Liquidation Guardian — one image serving the API (TanStack Start server
# functions), the Mini App / dashboard UI, and the Telegram bot (long-poll +
# watch loop) in a single Node process.

# ── Stage 1: install deps + typecheck + build the TanStack Start app ──────────
FROM node:22-alpine AS builder
WORKDIR /app

# Root deps first (better layer caching).
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

# Source.
COPY src ./src
COPY server ./server
COPY web ./web

# Typecheck the server/agent code, then build the Start app (SSR + nitro server).
RUN npm run typecheck
RUN npm ci --include=dev --prefix web && npm run build --prefix web

# ── Stage 2: slim runtime ─────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Root node_modules include tsx + runtime deps (openai, redis, dotenv).
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/src ./src
COPY --from=builder /app/server ./server
COPY --from=builder /app/web/package.json ./web/package.json
COPY --from=builder /app/web/node_modules ./web/node_modules
COPY --from=builder /app/web/.output ./web/.output

EXPOSE 3000
# The nitro server serves the API + SSR UI + bot in one process.
CMD ["node", "web/.output/server/index.mjs"]
