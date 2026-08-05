# Liquidation Guardian — one image serving the API, the Mini App / dashboard UI,
# and the Telegram bot (long-poll + watch loop) in a single Node process.
#
# The server runs via tsx (no separate JS emit), so the runtime image carries the
# TypeScript source plus node_modules (tsx included) and the prebuilt web/dist.

# ── Stage 1: install deps + typecheck + build the web UI ──────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

# Root deps first (better layer caching).
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

# Source.
COPY src ./src
COPY server ./server
COPY web ./web

# Typecheck the server/agent code, then build the front-end into web/dist.
RUN npm run typecheck
RUN npm ci --prefix web && npm run build --prefix web

# ── Stage 2: slim runtime ─────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Root node_modules include tsx + runtime deps (openai, redis, dotenv).
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/src ./src
COPY --from=builder /app/server ./server
COPY --from=builder /app/web/dist ./web/dist

EXPOSE 8787
# serve.ts reads web/dist relative to the working directory (/app/web/dist).
CMD ["node", "--import", "tsx", "server/serve.ts"]
