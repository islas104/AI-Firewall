# AI Agent Budget Proxy
# Base image digest-pinned for reproducible builds (a re-pull of the floating
# `22-alpine` tag can otherwise silently change the base). Update deliberately.
FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2

ENV NODE_ENV=production
WORKDIR /app

# Install deps first for layer caching
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY server.js ./
COPY src ./src
COPY public ./public

# Run as the non-root user node:alpine ships with
USER node

EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

CMD ["node", "server.js"]
