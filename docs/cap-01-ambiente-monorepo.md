# Capítulo 1 — Ambiente de Desenvolvimento & Monorepo

> **Objetivo:** Criar o monorepo Turborepo com Docker Compose completo, TypeScript strict configurado, ESLint/Prettier, todos os serviços de infraestrutura rodando em containers, e o esqueleto do CI/CD ativo desde o primeiro commit.

## O que você vai aprender

- Turborepo: pipeline de build cacheado para monorepos grandes
- Docker Compose com redes isoladas (segurança por design)
- TypeScript 6.0 strict mode — base compartilhada entre todos os apps
- ESLint + Prettier configurados uma vez, usados em toda a codebase
- Makefile para produtividade no dia a dia
- **CI/CD desde o dia 1** — GitHub Actions rodando lint e testes a cada PR

---

## Passo 1.1 — Inicializar o Monorepo

```bash
# Criar o workspace com pnpm + Turborepo
mkdir showpass && cd showpass
pnpm dlx create-turbo@latest . --package-manager pnpm

# Estrutura inicial que vamos construir:
# apps/api-gateway, apps/event-service, apps/booking-service,
# apps/payment-service, apps/search-service, apps/worker-service, apps/web
# packages/types, packages/kafka, packages/redis, packages/ui
```

---

## Passo 1.2 — `package.json` (root)

```json
{
  "name": "showpass",
  "private": true,
  "scripts": {
    "dev": "turbo run dev",
    "build": "turbo run build",
    "test": "turbo run test",
    "lint": "turbo run lint",
    "type-check": "turbo run type-check",
    "clean": "turbo run clean && rm -rf node_modules"
  },
  "devDependencies": {
    "turbo": "^2.5.0",
    "typescript": "^6.0.0",
    "@typescript-eslint/eslint-plugin": "^8.0.0",
    "@typescript-eslint/parser": "^8.0.0",
    "eslint": "^9.0.0",
    "eslint-config-prettier": "^10.0.0",
    "eslint-plugin-security": "^3.0.0",
    "prettier": "^3.5.0"
  },
  "engines": {
    "node": ">=22.0.0",
    "pnpm": ">=9.0.0"
  },
  "packageManager": "pnpm@9.15.0"
}
```

---

## Passo 1.3 — `turbo.json`

```json
{
  "$schema": "https://turbo.build/schema.json",
  "ui": "tui",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "inputs": ["$TURBO_DEFAULT$", ".env*"],
      "outputs": ["dist/**"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    },
    "test": {
      "dependsOn": ["^build"],
      "inputs": ["$TURBO_DEFAULT$", ".env.test"]
    },
    "lint": {
      "inputs": ["$TURBO_DEFAULT$"]
    },
    "type-check": {
      "inputs": ["$TURBO_DEFAULT$"]
    },
    "db:migrate": {
      "cache": false
    },
    "db:seed": {
      "cache": false,
      "dependsOn": ["db:migrate"]
    }
  }
}
```

---

## Passo 1.4 — TypeScript Base Config (`tsconfig.base.json`)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",

    // Strict mode completo — sem atalhos
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noPropertyAccessFromIndexSignature": true,
    "exactOptionalPropertyTypes": true,

    // Qualidade de código
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,

    // Interop
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,

    // Decorators (NestJS usa extensivamente)
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,

    "skipLibCheck": true
  }
}
```

---

## Passo 1.5 — ESLint Config (`eslint.config.mjs`)

```js
// eslint.config.mjs — ESLint v9 flat config
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import security from 'eslint-plugin-security';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  security.configs.recommended,  // OWASP A03: detecta injection patterns
  prettier,
  {
    rules: {
      // Forçar uso de tipos explícitos em retornos de funções públicas
      '@typescript-eslint/explicit-function-return-type': 'error',

      // Proibir 'any' — use 'unknown' e faça type narrowing
      '@typescript-eslint/no-explicit-any': 'error',

      // Garantir que Promises sejam sempre awaited ou void-cast
      '@typescript-eslint/no-floating-promises': 'error',

      // Proibir non-null assertion (!) — tratar nullability explicitamente
      '@typescript-eslint/no-non-null-assertion': 'error',

      // Segurança: não usar regex dinâmico (ReDoS)
      'security/detect-non-literal-regexp': 'error',
    },
  },
  {
    // Ignorar arquivos gerados automaticamente
    ignores: ['**/dist/**', '**/.next/**', '**/node_modules/**', '**/prisma/generated/**'],
  },
);
```

---

## Passo 1.6 — Prettier Config (`.prettierrc`)

```json
{
  "semi": true,
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100,
  "tabWidth": 2,
  "arrowParens": "always",
  "endOfLine": "lf"
}
```

---

## Passo 1.7 — `docker-compose.yml`

```yaml
# docker-compose.yml
#
# Ambiente completo de desenvolvimento.
# Redes isoladas por responsabilidade:
#   - public: somente o que o mundo externo acessa
#   - private: comunicação interna entre serviços
#   - data: bancos de dados e brokers (nunca expostos)

services:

  # ─────────────────────────────────────────────
  # INFRAESTRUTURA — rede `data` (isolada)
  # ─────────────────────────────────────────────

  postgres:
    image: postgres:18-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: showpass
      POSTGRES_PASSWORD: showpass_dev_secret
      POSTGRES_DB: showpass
    volumes:
      - postgres_data:/var/lib/postgresql/data
      # Script de init: cria databases separados por serviço
      - ./infra/docker/postgres/init.sql:/docker-entrypoint-initdb.d/init.sql
    ports:
      - "5432:5432"   # exposto apenas para dev (DBeaver, TablePlus)
    networks:
      - data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U showpass"]
      interval: 5s
      timeout: 5s
      retries: 5

  # ── Redis (dev: instância única) ────────────────────────────────────────────
  # Em produção usamos Redis Cluster Sentinel HA (3 nós: 1 primary + 2 replicas + 3 sentinels)
  # Sentinel detecta falha do primary e promove uma replica automaticamente (failover < 30s)
  # Ver: infra/terraform/main.tf → aws_elasticache_replication_group (num_cache_clusters: 3)
  redis:
    image: redis:8.6-alpine
    restart: unless-stopped
    command: >
      redis-server
      --requirepass redis_dev_secret
      --maxmemory 512mb
      --maxmemory-policy allkeys-lru
      --save ""
    ports:
      - "6379:6379"
    networks:
      - data
    healthcheck:
      test: ["CMD", "redis-cli", "-a", "redis_dev_secret", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5

  kafka:
    image: apache/kafka:4.2.0
    restart: unless-stopped
    environment:
      # KRaft mode — sem ZooKeeper
      KAFKA_NODE_ID: 1
      KAFKA_PROCESS_ROLES: broker,controller
      KAFKA_LISTENERS: PLAINTEXT://0.0.0.0:9092,CONTROLLER://0.0.0.0:9093
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://kafka:9092
      KAFKA_CONTROLLER_QUORUM_VOTERS: 1@kafka:9093
      KAFKA_CONTROLLER_LISTENER_NAMES: CONTROLLER
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1
      KAFKA_AUTO_CREATE_TOPICS_ENABLE: "true"
      KAFKA_LOG_RETENTION_MS: 604800000  # 7 dias
    ports:
      - "9092:9092"
    networks:
      - data
    healthcheck:
      test: ["CMD-SHELL", "/opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --list"]
      interval: 10s
      timeout: 10s
      retries: 5

  kafka-ui:
    image: provectuslabs/kafka-ui:latest
    restart: unless-stopped
    environment:
      KAFKA_CLUSTERS_0_NAME: showpass-local
      KAFKA_CLUSTERS_0_BOOTSTRAPSERVERS: kafka:9092
    ports:
      - "8080:8080"   # http://localhost:8080
    networks:
      - data
      - public
    depends_on:
      kafka:
        condition: service_healthy

  elasticsearch:
    image: docker.elastic.co/elasticsearch/elasticsearch:9.3.3
    restart: unless-stopped
    environment:
      discovery.type: single-node
      xpack.security.enabled: "false"     # desabilitar para dev (habilitar em prod)
      ES_JAVA_OPTS: "-Xms512m -Xmx512m"
    volumes:
      - elasticsearch_data:/usr/share/elasticsearch/data
    ports:
      - "9200:9200"
    networks:
      - data
    healthcheck:
      test: ["CMD-SHELL", "curl -sf http://localhost:9200/_cluster/health | grep -v '\"status\":\"red\"'"]
      interval: 10s
      timeout: 10s
      retries: 10

  # ─────────────────────────────────────────────
  # APLICAÇÕES — rede `private`
  # ─────────────────────────────────────────────

  api-gateway:
    build:
      context: .
      dockerfile: apps/api-gateway/Dockerfile
      target: dev
    restart: unless-stopped
    env_file: apps/api-gateway/.env
    ports:
      - "3001:3001"
    volumes:
      - ./apps/api-gateway/src:/app/src   # hot reload em dev
    networks:
      - public
      - private
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy

  event-service:
    build:
      context: .
      dockerfile: apps/event-service/Dockerfile
      target: dev
    restart: unless-stopped
    env_file: apps/event-service/.env
    ports:
      - "3002:3002"
    volumes:
      - ./apps/event-service/src:/app/src
    networks:
      - private
      - data
    depends_on:
      postgres:
        condition: service_healthy

  booking-service:
    build:
      context: .
      dockerfile: apps/booking-service/Dockerfile
      target: dev
    restart: unless-stopped
    env_file: apps/booking-service/.env
    ports:
      - "3003:3003"
    volumes:
      - ./apps/booking-service/src:/app/src
    networks:
      - private
      - data
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
      kafka:
        condition: service_healthy

  payment-service:
    build:
      context: .
      dockerfile: apps/payment-service/Dockerfile
      target: dev
    restart: unless-stopped
    env_file: apps/payment-service/.env
    ports:
      - "3004:3004"
    volumes:
      - ./apps/payment-service/src:/app/src
    networks:
      - private
      - data
    depends_on:
      postgres:
        condition: service_healthy
      kafka:
        condition: service_healthy

  search-service:
    build:
      context: .
      dockerfile: apps/search-service/Dockerfile
      target: dev
    restart: unless-stopped
    env_file: apps/search-service/.env
    ports:
      - "3005:3005"
    volumes:
      - ./apps/search-service/src:/app/src
    networks:
      - private
      - data
    depends_on:
      elasticsearch:
        condition: service_healthy
      kafka:
        condition: service_healthy

  worker-service:
    build:
      context: .
      dockerfile: apps/worker-service/Dockerfile
      target: dev
    restart: unless-stopped
    env_file: apps/worker-service/.env
    volumes:
      - ./apps/worker-service/src:/app/src
    networks:
      - private
      - data
    depends_on:
      kafka:
        condition: service_healthy
      postgres:
        condition: service_healthy

  web:
    build:
      context: .
      dockerfile: apps/web/Dockerfile
      target: dev
    restart: unless-stopped
    env_file: apps/web/.env
    ports:
      - "3000:3000"
    volumes:
      - ./apps/web/src:/app/src
    networks:
      - public
      - private

# ─────────────────────────────────────────────
# REDES
# ─────────────────────────────────────────────
networks:
  public:
    # Tráfego externo → api-gateway, web
  private:
    # Comunicação interna entre serviços
    internal: true
  data:
    # Bancos, Redis, Kafka — nunca acessíveis externamente
    internal: true

volumes:
  postgres_data:
  elasticsearch_data:
```

---

## Passo 1.8 — Script de init do PostgreSQL

```sql
-- infra/docker/postgres/init.sql
-- Cria um database por serviço — isolamento de dados

CREATE DATABASE showpass_events;
CREATE DATABASE showpass_booking;
CREATE DATABASE showpass_payment;
CREATE DATABASE showpass_auth;

-- Usuário com acesso restrito por database (principle of least privilege)
CREATE USER event_svc WITH PASSWORD 'event_svc_dev';
CREATE USER booking_svc WITH PASSWORD 'booking_svc_dev';
CREATE USER payment_svc WITH PASSWORD 'payment_svc_dev';
CREATE USER auth_svc WITH PASSWORD 'auth_svc_dev';

GRANT ALL PRIVILEGES ON DATABASE showpass_events  TO event_svc;
GRANT ALL PRIVILEGES ON DATABASE showpass_booking TO booking_svc;
GRANT ALL PRIVILEGES ON DATABASE showpass_payment TO payment_svc;
GRANT ALL PRIVILEGES ON DATABASE showpass_auth    TO auth_svc;
```

---

## Passo 1.9 — Dockerfile base para serviços NestJS

```dockerfile
# infra/docker/nestjs.Dockerfile
# Multi-stage: dev (hot reload) → builder → prod (imagem mínima)

# ─── Stage: base ──────────────────────────────────────────────────────────────
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

# ─── Stage: deps (instala dependências uma vez) ───────────────────────────────
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/ ./packages/
# --frozen-lockfile garante reproducibilidade (sem surpresas no CI)
RUN pnpm install --frozen-lockfile

# ─── Stage: dev (hot reload com tsx watch) ────────────────────────────────────
FROM deps AS dev
ENV NODE_ENV=development
# O código-fonte é montado via volume no docker-compose
CMD ["pnpm", "run", "dev"]

# ─── Stage: builder (transpila TypeScript) ────────────────────────────────────
FROM deps AS builder
ARG SERVICE_NAME
COPY apps/${SERVICE_NAME}/ ./apps/${SERVICE_NAME}/
RUN pnpm --filter @showpass/${SERVICE_NAME} run build

# ─── Stage: prod (imagem mínima — sem devDependencies, sem código fonte) ──────
FROM node:22-alpine AS prod
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

ENV NODE_ENV=production

ARG SERVICE_NAME
COPY --from=builder /app/apps/${SERVICE_NAME}/dist ./dist
COPY --from=builder /app/apps/${SERVICE_NAME}/package.json ./
COPY --from=deps /app/node_modules ./node_modules

# Usuário não-root — OWASP A05
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

EXPOSE 3000
CMD ["node", "dist/main.js"]
```

---

## Passo 1.10 — `.env.example` (por serviço)

```bash
# apps/event-service/.env.example
# Copie para .env e preencha os valores

# ── Servidor ────────────────────────────────────────────────────────────────
NODE_ENV=development
PORT=3002
SERVICE_NAME=event-service

# ── Banco de dados (database próprio do serviço) ─────────────────────────────
DATABASE_URL="postgresql://event_svc:event_svc_dev@localhost:5432/showpass_events"

# ── JWT (chave pública — apenas verificação, emissão é no auth-service) ──────
JWT_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"

# ── Kafka ────────────────────────────────────────────────────────────────────
KAFKA_BROKERS="localhost:9092"
KAFKA_CLIENT_ID="event-service"
KAFKA_GROUP_ID="event-service-group"

# ── Observabilidade ──────────────────────────────────────────────────────────
OTEL_SERVICE_NAME=event-service
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
```

---

## Passo 1.11 — `Makefile`

```makefile
# Makefile — comandos do dia a dia

.PHONY: dev build test lint infra-up infra-down db-migrate db-seed clean

# ─── Desenvolvimento ──────────────────────────────────────────────────────────
dev:
	docker compose up api-gateway event-service booking-service \
	  payment-service search-service worker-service web -d
	pnpm run dev

# Somente infraestrutura (postgres, redis, kafka, elasticsearch)
infra-up:
	docker compose up postgres redis kafka kafka-ui elasticsearch -d
	@echo "Aguardando serviços ficarem saudáveis..."
	@docker compose ps

infra-down:
	docker compose down

# ─── Banco de dados ───────────────────────────────────────────────────────────
db-migrate:
	pnpm --filter @showpass/event-service   run db:migrate
	pnpm --filter @showpass/booking-service run db:migrate
	pnpm --filter @showpass/payment-service run db:migrate
	pnpm --filter @showpass/auth-service    run db:migrate

db-seed:
	pnpm --filter @showpass/event-service run db:seed

db-studio:
	@echo "Abrindo Prisma Studio para qual serviço? (event|booking|payment|auth)"
	@read service; pnpm --filter @showpass/$$service-service run db:studio

# ─── Qualidade ────────────────────────────────────────────────────────────────
lint:
	pnpm run lint

type-check:
	pnpm run type-check

test:
	pnpm run test

test-e2e:
	pnpm run test:e2e

# ─── Build & Deploy ───────────────────────────────────────────────────────────
build:
	pnpm run build

clean:
	pnpm run clean
	docker compose down -v   # remove volumes de dados locais
```

---

## Passo 1.12 — Estrutura de um App NestJS (padrão do monorepo)

Cada serviço em `apps/` segue a mesma estrutura:

```
apps/event-service/
├── src/
│   ├── main.ts                   # Bootstrap NestJS + OpenTelemetry
│   ├── app.module.ts             # AppModule raiz
│   ├── modules/
│   │   ├── events/               # Feature module: Events
│   │   │   ├── events.module.ts
│   │   │   ├── events.controller.ts
│   │   │   ├── events.service.ts
│   │   │   ├── events.repository.ts  # Abstração do Prisma
│   │   │   └── dto/
│   │   │       ├── create-event.dto.ts
│   │   │       └── update-event.dto.ts
│   │   └── venues/
│   ├── common/
│   │   ├── filters/              # Exception filters (OWASP A09)
│   │   ├── interceptors/         # Logging, transform response
│   │   └── pipes/                # Zod validation pipe
│   └── prisma/
│       └── prisma.service.ts     # PrismaClient wrapper
├── prisma/
│   ├── schema.prisma             # Schema deste serviço
│   └── migrations/               # Migrations versionadas
├── test/
│   ├── unit/
│   └── e2e/
├── Dockerfile                    # Usa infra/docker/nestjs.Dockerfile
├── package.json
└── tsconfig.json
```

---

## Passo 1.13 — CI/CD desde o Dia 1

> **Por que desde o início?**  
> Configurar o CI no dia 1 garante que todo código que entra no repositório já passa por lint, type-check e testes. Não existe "vou adicionar CI depois" — esse atalho cria dívida técnica imediata.
>
> O workflow completo com build Docker, push para ECR e deploy no EKS vem no [Capítulo 15](cap-15-cicd.md). Aqui criamos o esqueleto que vai crescer.

```yaml
# .github/workflows/ci.yml
#
# Pipeline base — roda em todo PR e push para main.
# Cada capítulo vai expandir este arquivo:
#   Cap 02: adiciona db:migrate no job de testes
#   Cap 14: adiciona testes E2E e load test k6
#   Cap 15: adiciona build Docker, push ECR, deploy EKS

name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

# Cancelar runs anteriores do mesmo PR (economiza minutos do GitHub Actions)
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  # ─── Qualidade de código ──────────────────────────────────────────────────────
  quality:
    name: Lint & Type Check
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 9

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      # Lint em todos os pacotes em paralelo via Turborepo
      - name: Lint
        run: pnpm turbo run lint

      # Type-check — TypeScript 6.0, modo strict, sem any
      - name: Type Check
        run: pnpm turbo run type-check

      # Auditoria de segurança de dependências (OWASP A06)
      - name: Security Audit
        run: pnpm audit --audit-level=high
        # continue-on-error: true  ← descomente se quiser não bloquear na auditoria

  # ─── Testes unitários ─────────────────────────────────────────────────────────
  test:
    name: Unit Tests
    runs-on: ubuntu-latest
    needs: quality   # só roda se lint/type-check passaram
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 9

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      # Turborepo cache: se o código não mudou, reutiliza resultado anterior
      - name: Run Tests
        run: pnpm turbo run test
        env:
          NODE_ENV: test
```

```yaml
# .github/workflows/pr-title.yml
#
# Valida que o título do PR segue Conventional Commits:
# feat: nova funcionalidade
# fix: correção de bug
# chore: manutenção, CI, deps
# docs: documentação

name: PR Title Check

on:
  pull_request:
    types: [opened, edited, synchronize]

jobs:
  check-title:
    runs-on: ubuntu-latest
    steps:
      - uses: amannn/action-semantic-pull-request@v5
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        with:
          types: |
            feat
            fix
            chore
            docs
            test
            refactor
            perf
            ci
```

```
# .github/
# ├── workflows/
# │   ├── ci.yml              ← criado agora (lint + type-check + testes)
# │   ├── pr-title.yml        ← criado agora (Conventional Commits)
# │   ├── build.yml           ← Cap 15 (Docker build + push ECR)
# │   └── deploy.yml          ← Cap 15 (deploy EKS com Kustomize)
# └── CODEOWNERS              ← opcional: define revisores por área do código
```

---

## Recapitulando

Neste capítulo você configurou:

1. **Turborepo** com pipeline de build cacheado — builds paralelos e incrementais
2. **Docker Compose** com 3 redes isoladas (public/private/data) — segurança por design
3. **TypeScript 6.0 strict** como base compartilhada — zero tolerância a `any`
4. **ESLint + eslint-plugin-security** — detecta padrões de injection em tempo de lint
5. **PostgreSQL 18** com databases separados por serviço — bounded context no nível de dados
6. **Kafka 4.2 KRaft** — sem ZooKeeper, setup mais simples e moderno
7. **CI/CD desde o dia 1** — lint, type-check e testes rodam em todo PR
8. **Padrão de diretórios** para serviços NestJS — replicado em todos os `apps/`

---

## Próximo capítulo

[Capítulo 2 → Shared Packages & Prisma](cap-02-shared-packages-prisma.md)
