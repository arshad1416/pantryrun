# GroceryApp Relay Server — Dockerfile
# Multi-arch: builds for linux/amd64 and linux/arm64 via Docker Buildx

# Use official Node.js LTS image (multi-arch)
FROM --platform=$TARGETPLATFORM node:20-alpine AS build

ARG TARGETPLATFORM
RUN echo "Building for $TARGETPLATFORM"

FROM node:20-alpine

WORKDIR /app

# Copy package files and install dependencies
COPY package.json ./
RUN npm install --omit=dev && \
    npm cache clean --force

# Copy server source — explicit allowlist, NEVER `COPY . ./`:
# the build context contains keys/ (live issuer private key), data/ and
# relay-state.json / used-tokens.json (local state). A blanket copy would bake
# them into a published image. .dockerignore denies them too (defence in
# depth), and it also excludes tokens/__tests__/ and extract/*.bak* which a
# directory-level COPY would otherwise pull in.
COPY server.js seed-pool.js encrypted-store.js ./
COPY lib/ ./lib/
COPY tokens/ ./tokens/
COPY pool/ ./pool/
COPY extract/ ./extract/
COPY prices/ ./prices/

# Dedicated state directory — docker-compose mounts the relay-data volume here
# (RELAY_DATA_DIR=/data). Created and chowned in the image so a named volume
# inherits node-user ownership on first use; without this the volume ends up
# root-owned and the first state write fails after a clean-looking boot.
RUN mkdir -p /data && chown node:node /data

# Expose WebSocket port
EXPOSE 8080 8081

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:8080/health || exit 1

# Run the server (non-root user)
USER node
CMD ["node", "server.js"]
