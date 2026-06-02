FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4173
ENV ARTIFACT_STORAGE_DIR=/data/artifacts
ENV ARTIFACT_MAX_BYTES=10000000

RUN apk add --no-cache bash docker-cli postgresql-client

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 4173
VOLUME ["/data/artifacts"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 4173) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server/index.js"]
