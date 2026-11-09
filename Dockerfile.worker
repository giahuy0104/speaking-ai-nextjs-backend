FROM node:22-alpine AS dependencies
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
# tsx is required by the long-running worker, unlike the standalone web server.
RUN npm ci --no-audit --no-fund
COPY src/lib/ai/cloudflare/accountConfig.ts ./src/lib/ai/cloudflare/accountConfig.ts
COPY scripts/build-deployment-runtime.mjs ./scripts/build-deployment-runtime.mjs
RUN node scripts/build-deployment-runtime.mjs

FROM node:22-alpine AS worker
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=dependencies --chown=node:node /app/.deployment-runtime/pool-config.mjs ./infra/docker/pool-config.mjs
COPY --chown=node:node infra/docker/start.mjs infra/docker/runtime-config.mjs ./infra/docker/
COPY --chown=node:node package.json tsconfig.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node scripts/audio-translation-worker.ts ./scripts/audio-translation-worker.ts
USER node
CMD ["node", "--import", "tsx", "infra/docker/start.mjs", "worker"]
