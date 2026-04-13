# apps/auth-service/Dockerfile
# ATENÇÃO: este serviço é o único que conhece a chave privada RSA.
# A chave NÃO está na imagem — é injetada via variável de ambiente em runtime.
# Ver: apps/auth-service/CLAUDE.md

FROM node:22-alpine AS dev
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/ ./packages/
COPY apps/auth-service/ ./apps/auth-service/
RUN pnpm install --frozen-lockfile
CMD ["pnpm", "--filter", "@showpass/auth-service", "run", "dev"]

FROM dev AS builder
RUN pnpm --filter @showpass/auth-service run build

FROM node:22-alpine AS prod
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/apps/auth-service/dist ./dist
COPY --from=builder /app/apps/auth-service/package.json ./
COPY --from=builder /app/node_modules ./node_modules
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser
EXPOSE 3002
CMD ["node", "dist/main.js"]
