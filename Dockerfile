FROM node:20-slim AS base

# git: journal sync git pulls. python3/make/g++: native module compilation (better-sqlite3).
# wget: container healthcheck.
# node:20-slim is Debian (glibc) — required for onnxruntime-node prebuilt binaries used by
# @xenova/transformers. Alpine (musl) breaks onnxruntime-node with ERR_DLOPEN_FAILED.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git python3 make g++ wget \
    && rm -rf /var/lib/apt/lists/*

# Run as node user (uid 1000, gid 1000) — matches default Linux user on most hosts,
# which allows git pull on bind-mounted team-context repos without permission issues.
RUN mkdir -p /home/node/.claude/team-context/content-store \
    && chown -R node:node /home/node/.claude

WORKDIR /app

# Install production dependencies first (layer caching)
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

# Copy application source
COPY bin/ bin/
COPY templates/ templates/
COPY specializations/ specializations/

# Pre-download the Xenova embedding model at build time so it's baked into the
# image. Avoids an 80MB network download on every cold start at runtime.
# WAYFIND_MODEL_CACHE is also read by generateEmbeddingLocal() in llm.js.
ENV WAYFIND_MODEL_CACHE=/app/.xenova-cache
RUN mkdir -p /app/.xenova-cache && chown -R node:node /app/.xenova-cache
USER node
RUN node -e "\
  const {pipeline, env} = require('@xenova/transformers'); \
  env.cacheDir = '/app/.xenova-cache'; \
  pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2') \
    .then(() => { process.stderr.write('Xenova model ready\\n'); process.exit(0); }) \
    .catch(e => { process.stderr.write('Model download failed: ' + e.message + '\\n'); process.exit(1); });"

# Health check — start command exposes /healthz
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3141/healthz || exit 1

# Default mode: all-in-one (override via TEAM_CONTEXT_MODE)
ENV TEAM_CONTEXT_MODE=all-in-one
ENV NODE_ENV=production

EXPOSE 3141

ENTRYPOINT ["node", "bin/team-context.js"]
CMD ["start"]
