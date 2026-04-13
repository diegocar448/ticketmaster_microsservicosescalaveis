# apps/search-service/Dockerfile
FROM node:22-alpine AS dev
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/ ./packages/
COPY apps/search-service/ ./apps/search-service/
RUN pnpm install --frozen-lockfile
CMD ["pnpm", "--filter", "@showpass/search-service", "run", "dev"]

FROM dev AS builder
RUN pnpm --filter @showpass/search-service run build

FROM node:22-alpine AS prod
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/apps/search-service/dist ./dist
COPY --from=builder /app/apps/search-service/package.json ./
COPY --from=builder /app/node_modules ./node_modules
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser
EXPOSE 3006
CMD ["node", "dist/main.js"]
