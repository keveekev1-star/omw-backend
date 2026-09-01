# ─── BUILD STAGE ──────────────────────────────────────────────────────────────
FROM node:20-alpine AS base

# Security: run as non-root user
RUN addgroup -g 1001 -S omw && adduser -u 1001 -S omw -G omw

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

# Copy source
COPY src/ ./src/

# Set ownership
RUN chown -R omw:omw /app

# ─── RUNTIME ──────────────────────────────────────────────────────────────────
FROM node:20-alpine

RUN addgroup -g 1001 -S omw && adduser -u 1001 -S omw -G omw

WORKDIR /app

COPY --from=base --chown=omw:omw /app ./

USER omw

EXPOSE 4000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:4000/health || exit 1

CMD ["node", "src/server.js"]
