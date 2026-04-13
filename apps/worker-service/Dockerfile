# apps/worker-service/Dockerfile
# ATENÇÃO: worker usa Puppeteer (Chrome headless) — imagem maior que os outros serviços.
# Escala VERTICALMENTE (CPU/RAM), não horizontalmente.
# Ver: infra/CLAUDE.md — Worker Service deve ter limits: memory: 4Gi, cpu: 2000m

FROM node:22-alpine AS dev
# Puppeteer precisa do Chromium e suas dependências
RUN apk add --no-cache chromium nss freetype harfbuzz ca-certificates ttf-freefont
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/ ./packages/
COPY apps/worker-service/ ./apps/worker-service/
RUN pnpm install --frozen-lockfile
CMD ["pnpm", "--filter", "@showpass/worker-service", "run", "dev"]

FROM dev AS builder
RUN pnpm --filter @showpass/worker-service run build

FROM node:22-alpine AS prod
RUN apk add --no-cache chromium nss freetype harfbuzz ca-certificates ttf-freefont
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
ENV NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app
COPY --from=builder /app/apps/worker-service/dist ./dist
COPY --from=builder /app/apps/worker-service/package.json ./
COPY --from=builder /app/node_modules ./node_modules
# Usuário não-root — mas Puppeteer precisa de algumas capacidades específicas
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser
CMD ["node", "dist/main.js"]
