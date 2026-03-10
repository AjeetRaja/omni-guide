# ─── Omni-Guide Backend — Dockerfile ───────────────────────────────────────
# Multi-stage build for a lean production image

FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies first (layer caching)
COPY backend/package.json ./
RUN npm install --omit=dev

# ─── Production Stage ────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

# Create non-root user for security
RUN addgroup -S omni && adduser -S omni -G omni

# Copy deps and source
COPY --from=builder /app/node_modules ./node_modules
COPY backend/ .

# Evidence files directory
RUN mkdir -p ./evidence_files && chown omni:omni ./evidence_files

USER omni

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -q -O- http://localhost:3001/health || exit 1

CMD ["node", "server.js"]
