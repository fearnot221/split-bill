# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS verified
COPY server.js db.js ./
COPY lib ./lib
COPY public ./public
COPY scripts ./scripts
COPY test ./test
COPY README.md ./
RUN npm run verify

FROM node:22-bookworm-slim AS runtime
ARG COMMIT_SHA=unknown
LABEL org.opencontainers.image.source="https://github.com/fearnot221/split-bill" \
      org.opencontainers.image.revision="$COMMIT_SHA"

WORKDIR /app
COPY --from=verified /app/package.json /app/package-lock.json ./
COPY --from=verified /app/node_modules ./node_modules
COPY --from=verified /app/server.js /app/db.js ./
COPY --from=verified /app/lib ./lib
COPY --from=verified /app/public ./public
COPY --from=verified /app/scripts ./scripts

ENV APP_REVISION=$COMMIT_SHA \
    NODE_ENV=production \
    PORT=3100 \
    HOST=0.0.0.0 \
    DB_PATH=/data/data.db \
    UPLOAD_DIR=/data/uploads \
    BACKUP_DIR=/data/backups

USER node
EXPOSE 3100
HEALTHCHECK --interval=10s --timeout=4s --start-period=10s --retries=5 \
  CMD node -e 'fetch("http://127.0.0.1:3100/healthz").then(async (response) => process.exit(response.ok && await response.text() === "ok" ? 0 : 1)).catch(() => process.exit(1))'
CMD ["node", "-r", "dotenv/config", "server.js"]
