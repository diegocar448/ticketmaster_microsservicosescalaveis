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
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc .pnpmfile.cjs ./
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
RUN pnpm --filter @showpass/${SERVICE_NAME} run build

# ─── Stage: prod (imagem mínima — sem devDependencies, sem código fonte) ──────
# Esta é a imagem que vai para o ECR e roda no EKS
FROM node:22-alpine AS prod
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

ENV NODE_ENV=production

ARG SERVICE_NAME
COPY --from=builder /app/apps/${SERVICE_NAME}/dist ./dist
COPY --from=builder /app/apps/${SERVICE_NAME}/package.json ./
COPY --from=deps /app/node_modules ./node_modules

# Usuário não-root — OWASP A05 (Security Misconfiguration)
# Containers que rodam como root são um vetor de escalada de privilégio
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

EXPOSE 3000
CMD ["node", "dist/main.js"]
