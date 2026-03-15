FROM node:20-alpine AS base

# git is needed for pulling team-context repo updates (journal sync)
RUN apk add --no-cache git
RUN apk add --no-cache python3 make g++

# Run as node user (uid 1000, gid 1000) — matches default Linux user on most hosts,
# which allows git pull on bind-mounted team-context repos without permission issues.
RUN mkdir -p /home/node/.claude/meridian/content-store \
    && chown -R node:node /home/node/.claude

WORKDIR /app

# Install production dependencies first (layer caching)
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

# Copy application source
COPY bin/ bin/
COPY templates/ templates/
COPY specializations/ specializations/

# Health check — start command exposes /healthz
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3141/healthz || exit 1

# Drop to non-root (node user = uid 1000, matches most host users)
USER node

# Default mode: all-in-one (override via MERIDIAN_MODE)
ENV MERIDIAN_MODE=all-in-one
ENV NODE_ENV=production

EXPOSE 3141

ENTRYPOINT ["node", "bin/meridian.js"]
CMD ["start"]
