# apps/worker-service/Dockerfile
# ATENÇÃO: worker usa Puppeteer (Chrome headless) — imagem maior que os outros serviços.
# Escala VERTICALMENTE (CPU/RAM), não horizontalmente.
# Ver: infra/CLAUDE.md — Worker Service deve ter limits: memory: 4Gi, cpu: 2000m

FROM node:22-alpine AS dev
# Puppeteer precisa do Chromium e suas dependências
RUN apk add --no-cache chromium nss freetype harfbuzz ca-certificates ttf-freefont
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app
# .npmrc + .pnpmfile.cjs presentes antes do install — sem eles o
# --frozen-lockfile aborta com ERR_PNPM_LOCKFILE_CONFIG_MISMATCH (pnpmfileChecksum).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc .pnpmfile.cjs tsconfig.base.json ./
COPY packages/ ./packages/
COPY apps/worker-service/ ./apps/worker-service/
RUN pnpm install --frozen-lockfile
CMD ["pnpm", "--filter", "@showpass/worker-service", "run", "dev"]

FROM dev AS builder
# Buildar os packages workspace → dist JS (sem isso, node dist/main.js tenta
# carregar o .ts cru de node_modules → ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING).
RUN pnpm --filter "@showpass/types" --filter "@showpass/redis" --filter "@showpass/kafka" run build
# Prisma client (gitignored — gerar no build). Driver adapter → client JS puro.
RUN pnpm --filter @showpass/worker-service run db:generate
RUN pnpm --filter @showpass/worker-service run build
# Client gerado é excluído do tsc — copiar para dentro de dist (import ./generated/index.js).
RUN cp -r apps/worker-service/src/prisma/generated apps/worker-service/dist/prisma/generated
# pnpm deploy: bundle prod com node_modules FLAT (resolve o store isolado do pnpm).
RUN pnpm --filter @showpass/worker-service --prod deploy /prod-app

FROM node:22-alpine AS prod
RUN apk add --no-cache chromium nss freetype harfbuzz ca-certificates ttf-freefont
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder /prod-app/node_modules ./node_modules
COPY --from=builder /app/apps/worker-service/dist ./dist
COPY --from=builder /app/apps/worker-service/package.json ./
# UID numérico 1001: K8s só verifica runAsNonRoot com USER numérico (cap-16).
RUN addgroup -S -g 1001 appgroup && adduser -S -D -u 1001 -G appgroup appuser
USER 1001
CMD ["node", "dist/main.js"]
