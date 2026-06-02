# apps/api-gateway/Dockerfile
# Multi-stage: dev (hot reload) → builder → prod (imagem mínima)
# Ver: infra/docker/nestjs.Dockerfile para a documentação do padrão

# ─── Stage: dev ───────────────────────────────────────────────────────────────
FROM node:22-alpine AS dev
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app
# .npmrc + .pnpmfile.cjs precisam estar presentes ANTES do install: o lockfile
# grava `pnpmfileChecksum` quando há .pnpmfile.cjs no projeto; se o arquivo
# falta na imagem, pnpm --frozen-lockfile aborta com ERR_PNPM_LOCKFILE_CONFIG_MISMATCH.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc .pnpmfile.cjs tsconfig.base.json ./
COPY packages/ ./packages/
COPY apps/api-gateway/ ./apps/api-gateway/
RUN pnpm install --frozen-lockfile
CMD ["pnpm", "--filter", "@showpass/api-gateway", "run", "dev"]

# ─── Stage: builder ───────────────────────────────────────────────────────────
FROM dev AS builder
# Buildar os packages workspace → dist JS (sem isso, node dist/main.js tenta
# carregar o .ts cru de node_modules → ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING).
RUN pnpm --filter "@showpass/types" --filter "@showpass/redis" --filter "@showpass/kafka" run build
RUN pnpm --filter @showpass/api-gateway run build
# pnpm deploy: bundle prod com node_modules FLAT (resolve o store isolado do pnpm).
RUN pnpm --filter @showpass/api-gateway --prod deploy /prod-app

# ─── Stage: prod (imagem mínima — OWASP A05) ─────────────────────────────────
FROM node:22-alpine AS prod
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /prod-app/node_modules ./node_modules
COPY --from=builder /app/apps/api-gateway/dist ./dist
COPY --from=builder /app/apps/api-gateway/package.json ./
# UID numérico 1001: K8s só verifica runAsNonRoot com USER numérico (cap-16).
RUN addgroup -S -g 1001 appgroup && adduser -S -D -u 1001 -G appgroup appuser
USER 1001
EXPOSE 3001
CMD ["node", "dist/main.js"]
