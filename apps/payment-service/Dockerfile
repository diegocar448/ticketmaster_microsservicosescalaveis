# apps/payment-service/Dockerfile
FROM node:22-alpine AS dev
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/ ./packages/
COPY apps/payment-service/ ./apps/payment-service/
RUN pnpm install --frozen-lockfile
CMD ["pnpm", "--filter", "@showpass/payment-service", "run", "dev"]

FROM dev AS builder
RUN pnpm --filter @showpass/payment-service run build

FROM node:22-alpine AS prod
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/apps/payment-service/dist ./dist
COPY --from=builder /app/apps/payment-service/package.json ./
COPY --from=builder /app/node_modules ./node_modules
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser
EXPOSE 3005
CMD ["node", "dist/main.js"]
