FROM node:24-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY scripts ./scripts

ENV NODE_ENV=production MCP_HOST=0.0.0.0 MCP_PORT=3005
EXPOSE 3005
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
    CMD wget -qO- http://127.0.0.1:3005/health >/dev/null || exit 1

CMD ["node", "src/index.js"]
