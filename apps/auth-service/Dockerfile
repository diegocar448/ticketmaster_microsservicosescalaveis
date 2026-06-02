# apps/auth-service/Dockerfile
# ATENÇÃO: este serviço é o único que conhece a chave privada RSA.
# A chave NÃO está na imagem — é injetada via variável de ambiente em runtime.
# Ver: apps/auth-service/CLAUDE.md

FROM node:22-alpine AS dev
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app
# .npmrc + .pnpmfile.cjs presentes antes do install — sem eles o
# --frozen-lockfile aborta com ERR_PNPM_LOCKFILE_CONFIG_MISMATCH (pnpmfileChecksum).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc .pnpmfile.cjs tsconfig.base.json ./
COPY packages/ ./packages/
COPY apps/auth-service/ ./apps/auth-service/
RUN pnpm install --frozen-lockfile
CMD ["pnpm", "--filter", "@showpass/auth-service", "run", "dev"]

FROM dev AS builder
# Buildar os packages workspace → dist JS (sem isso, node dist/main.js tenta
# carregar o .ts cru de node_modules → ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING).
RUN pnpm --filter "@showpass/types" --filter "@showpass/redis" --filter "@showpass/kafka" run build
# Prisma client (gitignored — gerar no build). Driver adapter → client JS puro.
RUN pnpm --filter @showpass/auth-service run db:generate
RUN pnpm --filter @showpass/auth-service run build
# Client gerado é excluído do tsc — copiar para dentro de dist (import ./generated/index.js).
RUN cp -r apps/auth-service/src/prisma/generated apps/auth-service/dist/prisma/generated
# pnpm deploy: bundle prod com node_modules FLAT (resolve o store isolado do pnpm).
RUN pnpm --filter @showpass/auth-service --prod deploy /prod-app

FROM node:22-alpine AS prod
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /prod-app/node_modules ./node_modules
COPY --from=builder /app/apps/auth-service/dist ./dist
COPY --from=builder /app/apps/auth-service/package.json ./
# UID numérico 1001: K8s só verifica runAsNonRoot com USER numérico (cap-16).
RUN addgroup -S -g 1001 appgroup && adduser -S -D -u 1001 -G appgroup appuser
USER 1001
EXPOSE 3002
CMD ["node", "dist/main.js"]
