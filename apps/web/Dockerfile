# apps/web/Dockerfile
# Next.js com standalone output para imagem mínima em produção

FROM node:22-alpine AS dev
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/ ./packages/
COPY apps/web/ ./apps/web/
RUN pnpm install --frozen-lockfile
CMD ["pnpm", "--filter", "@showpass/web", "run", "dev"]

FROM dev AS builder
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @showpass/web run build

FROM node:22-alpine AS prod
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app
# Next.js standalone: contém apenas os arquivos necessários para produção
COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /app/apps/web/public ./apps/web/public
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
