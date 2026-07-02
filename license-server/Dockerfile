FROM node:22-bookworm-slim

WORKDIR /app
COPY license-server/package.json license-server/package-lock.json ./
RUN npm ci --omit=dev

COPY license-server/src ./src
COPY license-server/public ./public
COPY license-server/scripts ./scripts
COPY shared /shared

ENV NODE_ENV=production
EXPOSE 8787
CMD ["node", "src/index.mjs"]
