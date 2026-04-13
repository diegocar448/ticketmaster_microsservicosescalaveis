# apps/booking-service/Dockerfile
# ATENÇÃO: este serviço contém a lógica crítica de anti-double-booking.
# Ver: apps/booking-service/CLAUDE.md antes de qualquer alteração.
FROM node:22-alpine AS dev
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/ ./packages/
COPY apps/booking-service/ ./apps/booking-service/
RUN pnpm install --frozen-lockfile
CMD ["pnpm", "--filter", "@showpass/booking-service", "run", "dev"]

FROM dev AS builder
RUN pnpm --filter @showpass/booking-service run build

FROM node:22-alpine AS prod
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/apps/booking-service/dist ./dist
COPY --from=builder /app/apps/booking-service/package.json ./
COPY --from=builder /app/node_modules ./node_modules
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser
EXPOSE 3004
CMD ["node", "dist/main.js"]
