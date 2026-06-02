# apps/booking-service/Dockerfile
# ATENÇÃO: este serviço contém a lógica crítica de anti-double-booking.
# Ver: apps/booking-service/CLAUDE.md antes de qualquer alteração.
FROM node:22-alpine AS dev
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app
# .npmrc + .pnpmfile.cjs presentes antes do install — sem eles o
# --frozen-lockfile aborta com ERR_PNPM_LOCKFILE_CONFIG_MISMATCH (pnpmfileChecksum).
# tsconfig.base.json é necessário tanto no build (tsc -p tsconfig.build.json,
# que herda da base) quanto no runtime dev (swc-node lê a base).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc .pnpmfile.cjs tsconfig.base.json ./
COPY packages/ ./packages/
COPY apps/booking-service/ ./apps/booking-service/
RUN pnpm install --frozen-lockfile
CMD ["pnpm", "--filter", "@showpass/booking-service", "run", "dev"]

FROM dev AS builder
# Buildar os packages workspace (@showpass/types|redis|kafka) → dist JS. Eles
# têm `main: ./dist/index.js`; sem o build, o `node dist/main.js` em prod tenta
# carregar o .ts cru de node_modules → ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING.
RUN pnpm --filter "@showpass/types" --filter "@showpass/redis" --filter "@showpass/kafka" run build
# Gerar o Prisma Client (output em src/prisma/generated) ANTES do tsc — o
# diretório é gitignored, então NÃO vem no checkout limpo do CI; precisa
# ser gerado no build. Com driver adapter (@prisma/adapter-pg) o client é
# JS puro (sem engine binário nativo) — portável entre plataformas.
RUN pnpm --filter @showpass/booking-service run db:generate
RUN pnpm --filter @showpass/booking-service run build
# O client gerado é EXCLUÍDO do tsc (não é TS) — copiar para dentro de dist
# para que `dist/prisma/prisma.service.js` resolva `./generated/index.js`.
RUN cp -r apps/booking-service/src/prisma/generated apps/booking-service/dist/prisma/generated
# pnpm deploy: bundle self-contained com node_modules FLAT (sem o store
# isolado do pnpm). Sem isso, `node dist/main.js` não acha deps como
# reflect-metadata — que ficam só em apps/<svc>/node_modules + .pnpm, NÃO no
# node_modules raiz. --prod remove devDependencies; deps workspace são embutidas.
RUN pnpm --filter @showpass/booking-service --prod deploy /prod-app

FROM node:22-alpine AS prod
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /prod-app/node_modules ./node_modules
COPY --from=builder /app/apps/booking-service/dist ./dist
COPY --from=builder /app/apps/booking-service/package.json ./
# UID numérico 1001 (não só nome): o K8s só consegue verificar runAsNonRoot
# quando o USER é numérico. Alinha com runAsUser: 1001 do manifesto (cap-16).
RUN addgroup -S -g 1001 appgroup && adduser -S -D -u 1001 -G appgroup appuser
USER 1001
EXPOSE 3004
CMD ["node", "dist/main.js"]
