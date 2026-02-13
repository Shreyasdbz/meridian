# Meridian — Multi-stage Docker build
# One image for all tiers. Tier-specific Node.js memory flags are set at
# runtime via the MERIDIAN_NODE_FLAGS env var (see docs/deployment.md).

# =============================================================================
# Stage 1: Build
# =============================================================================
FROM node:20-slim AS build

WORKDIR /app

# Install build dependencies for native modules (better-sqlite3, argon2)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      python3 \
      make \
      g++ \
      && rm -rf /var/lib/apt/lists/*

# Copy package files and install dependencies
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts && \
    npm rebuild better-sqlite3 argon2

# Copy source and build
COPY tsconfig.json tsup.config.ts vite.config.ts ./
COPY src/ src/
COPY index.html ./

RUN npm run build && npm run build:ui

# Prune dev dependencies
RUN npm prune --production

# =============================================================================
# Stage 2: Runtime
# =============================================================================
FROM node:20-slim AS runtime

# Install runtime dependencies for native modules
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      tini \
      && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd --gid 1001 meridian && \
    useradd --uid 1001 --gid meridian --shell /bin/false --create-home meridian

WORKDIR /app

# Copy built artifacts and production dependencies
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./

# Create data and workspace directories
RUN mkdir -p /data /workspace && \
    chown -R meridian:meridian /data /workspace /app

# Volumes for persistent data
VOLUME ["/data", "/workspace"]

# Expose Bridge port
EXPOSE 3000

# Security: non-root user (runtime hardening via docker-compose.yml:
# no-new-privileges, read-only root filesystem, tmpfs)
USER meridian

# Deployment tier is configurable via MERIDIAN_TIER env var.
# Node.js memory flags are set via MERIDIAN_NODE_FLAGS.
#
# Recommended flag values by tier:
#   Desktop / VPS:     --max-old-space-size=2048
#   Raspberry Pi 8GB:  --max-old-space-size=1024
#   Raspberry Pi 4GB:  --max-old-space-size=512 --optimize-for-size
#
# Note: RPi 4GB model is only viable without local Ollama.
# Ollama embeddings require the 8GB model (see architecture Section 10.1).
ENV MERIDIAN_DATA_DIR=/data
ENV MERIDIAN_WORKSPACE_DIR=/workspace
ENV MERIDIAN_BRIDGE_BIND=0.0.0.0
ENV MERIDIAN_NODE_FLAGS="--max-old-space-size=2048"

# Use tini as PID 1 for proper signal handling
ENTRYPOINT ["tini", "--"]

# Start Meridian with tier-appropriate Node.js flags
CMD ["sh", "-c", "exec node ${MERIDIAN_NODE_FLAGS} dist/index.js"]
