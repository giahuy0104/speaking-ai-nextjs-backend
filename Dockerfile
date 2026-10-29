FROM node:22-alpine AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS dependencies
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM base AS builder
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
ENV NEXT_OUTPUT_STANDALONE=true
RUN npm run build

FROM dependencies AS deployment-config
COPY src/lib/ai/cloudflare/accountConfig.ts ./src/lib/ai/cloudflare/accountConfig.ts
COPY scripts/build-deployment-runtime.mjs ./scripts/build-deployment-runtime.mjs
RUN node scripts/build-deployment-runtime.mjs

FROM base AS runtime
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    KEEP_ALIVE_TIMEOUT=70000
RUN mkdir -p /app/data/audio-translation-jobs && chown -R node:node /app/data
COPY --chown=node:node infra/docker/start.mjs infra/docker/runtime-config.mjs ./infra/docker/
COPY --from=deployment-config --chown=node:node /app/.deployment-runtime/pool-config.mjs ./infra/docker/pool-config.mjs
USER node

# Optional durable-job worker; enabled with the Compose "jobs" profile.
FROM runtime AS worker
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json tsconfig.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node scripts/audio-translation-worker.ts ./scripts/audio-translation-worker.ts
CMD ["node", "--import", "tsx", "infra/docker/start.mjs", "worker"]

FROM runtime AS web
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
# Railway injects PORT; Compose supplies 3000 or 3001.
CMD ["node", "infra/docker/start.mjs"]

