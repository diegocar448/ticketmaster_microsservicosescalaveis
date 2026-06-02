# syntax=docker/dockerfile:1.7-labs
# infra/docker/nestjs.Dockerfile
# Multi-stage: dev (hot reload) → builder → prod (imagem mínima)
#
# syntax 1.7-labs habilita `COPY --parents` (preserva apps/<svc>/ no destino).
#
# Cada serviço em apps/ tem seu próprio Dockerfile que usa este como base.
# ARG SERVICE_NAME é passado pelo docker-compose ou pelo CI.

# ─── Stage: base ──────────────────────────────────────────────────────────────
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

# ─── Stage: deps (instala dependências uma vez, usa cache de camada) ──────────
FROM base AS deps
# .npmrc + .pnpmfile.cjs PRECISAM existir ANTES do install: o .pnpmfile.cjs
# reescreve deps via hook readPackage (patch de segurança do tar). O lockfile
# foi gerado COM esse hook aplicado — sem o arquivo, a resolução diverge e
# --frozen-lockfile falha.
# tsconfig.base.json é necessário no build (tsc -p tsconfig.build.json herda
# da base) E no runtime dev (swc-node lê a base) — sem ele o build falha com
# TS5083 "Cannot read file tsconfig.base.json".
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc .pnpmfile.cjs tsconfig.base.json ./
# pnpm --frozen-lockfile valida o lockfile contra o grafo COMPLETO de
# workspaces. Sem os package.json de apps/* o grafo fica incompleto e a
# verificação falha. --parents preserva a estrutura apps/<svc>/package.json.
COPY --parents apps/*/package.json packages/*/package.json ./
COPY packages/ ./packages/
# --frozen-lockfile garante reproducibilidade (sem surpresas no CI)
RUN pnpm install --frozen-lockfile

# ─── Stage: dev (hot reload com tsx watch) ────────────────────────────────────
# O código-fonte é montado via volume no docker-compose, não copiado
FROM deps AS dev
ENV NODE_ENV=development
ARG SERVICE_NAME
COPY apps/${SERVICE_NAME}/ ./apps/${SERVICE_NAME}/
CMD ["pnpm", "--filter", "@showpass/${SERVICE_NAME}", "run", "dev"]

# ─── Stage: builder (transpila TypeScript para JavaScript) ────────────────────
FROM deps AS builder
ARG SERVICE_NAME
COPY apps/${SERVICE_NAME}/ ./apps/${SERVICE_NAME}/
# 1) Buildar os packages workspace → dist JS. Eles têm `main: ./dist/index.js`;
#    sem o build, `node dist/main.js` em prod tenta carregar o .ts cru de
#    node_modules → ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING.
RUN pnpm --filter "@showpass/types" --filter "@showpass/redis" --filter "@showpass/kafka" run build
# 2) (Serviços Prisma) gerar o client — gitignored, ausente no checkout limpo.
#    Pular esta linha em serviços sem Prisma (api-gateway, search).
RUN pnpm --filter @showpass/${SERVICE_NAME} run db:generate
RUN pnpm --filter @showpass/${SERVICE_NAME} run build
# 3) (Serviços Prisma) o client gerado é JS puro, EXCLUÍDO do tsc — copiar para
#    dentro de dist para que `dist/prisma/*.js` resolva `./generated/index.js`.
RUN cp -r apps/${SERVICE_NAME}/src/prisma/generated apps/${SERVICE_NAME}/dist/prisma/generated
# 4) pnpm deploy: bundle prod com node_modules FLAT. O store isolado do pnpm
#    deixa as deps só em apps/<svc>/node_modules + .pnpm, NÃO no node_modules
#    raiz — sem deploy, `node dist/main.js` não acha reflect-metadata etc.
RUN pnpm --filter @showpass/${SERVICE_NAME} --prod deploy /prod-app

# ─── Stage: prod (imagem mínima — sem devDependencies, sem código fonte) ──────
# Esta é a imagem que vai para o ECR e roda no EKS
FROM node:22-alpine AS prod
WORKDIR /app

ENV NODE_ENV=production

ARG SERVICE_NAME
COPY --from=builder /prod-app/node_modules ./node_modules
COPY --from=builder /app/apps/${SERVICE_NAME}/dist ./dist
COPY --from=builder /app/apps/${SERVICE_NAME}/package.json ./

# Usuário não-root com UID NUMÉRICO 1001 (OWASP A05). O número (não só o nome)
# é o que permite ao K8s verificar runAsNonRoot — ver cap-16 (runAsUser: 1001).
RUN addgroup -S -g 1001 appgroup && adduser -S -D -u 1001 -G appgroup appuser
USER 1001

EXPOSE 3000
CMD ["node", "dist/main.js"]
