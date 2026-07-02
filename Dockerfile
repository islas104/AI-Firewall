# AI Agent Budget Proxy
FROM node:22-alpine

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
