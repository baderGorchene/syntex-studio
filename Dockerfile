# ==============================================================================
# Synthex Studio: Production Multi-Stage Dockerfile for Google Cloud Run
# ==============================================================================

# ------------------------------------------------------------------------------
# 1. Base image & native dependencies
# ------------------------------------------------------------------------------
FROM node:20-slim AS base
WORKDIR /app
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# ------------------------------------------------------------------------------
# 2. Dependencies installation
# ------------------------------------------------------------------------------
FROM base AS deps
COPY package.json package-lock.json* ./
# The cloud image never runs Electron: skip its ~100 MB binary download.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN npm ci

# ------------------------------------------------------------------------------
# 3. Source build
# ------------------------------------------------------------------------------
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

RUN npm run build

# ------------------------------------------------------------------------------
# 4. Production Runner for Google Cloud Run
# ------------------------------------------------------------------------------
FROM node:20-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=8080
ENV HOSTNAME="0.0.0.0"

# Create a non-root system user
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Copy static assets and standalone server bundle
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Create writable directory for local fallback storage if needed
RUN mkdir -p /app/public/uploads && chown -R nextjs:nodejs /app/public/uploads

USER nextjs

EXPOSE 8080

CMD ["node", "server.js"]
