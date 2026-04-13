# apps/api-gateway/Dockerfile
# Multi-stage: dev (hot reload) → builder → prod (imagem mínima)
# Ver: infra/docker/nestjs.Dockerfile para a documentação do padrão

# ─── Stage: dev ───────────────────────────────────────────────────────────────
FROM node:22-alpine AS dev
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/ ./packages/
COPY apps/api-gateway/ ./apps/api-gateway/
RUN pnpm install --frozen-lockfile
CMD ["pnpm", "--filter", "@showpass/api-gateway", "run", "dev"]

# ─── Stage: builder ───────────────────────────────────────────────────────────
FROM dev AS builder
RUN pnpm --filter @showpass/api-gateway run build

# ─── Stage: prod (imagem mínima — OWASP A05) ─────────────────────────────────
FROM node:22-alpine AS prod
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/apps/api-gateway/dist ./dist
COPY --from=builder /app/apps/api-gateway/package.json ./
COPY --from=builder /app/node_modules ./node_modules
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser
EXPOSE 3001
CMD ["node", "dist/main.js"]
