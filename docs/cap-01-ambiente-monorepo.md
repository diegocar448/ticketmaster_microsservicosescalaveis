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
      # postgres:18+ exige mount em /var/lib/postgresql (não /data)
      # permite pg_upgrade --link entre major versions sem cruzar mount boundaries
      - postgres_data:/var/lib/postgresql
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

Cada serviço tem um `.env.example` com os nomes e valores padrão de desenvolvimento. O arquivo `.env` (com valores reais) não é versionado — está no `.gitignore`.

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

### Criar os `.env` de todos os serviços

O `docker-compose.yml` usa `env_file` para cada serviço — se o arquivo não existir, o `docker compose up` falha com `env file not found`. **Antes de rodar qualquer comando docker compose**, crie os arquivos para todos os serviços:

```bash
# A partir da raiz do monorepo — copia todos os .env.example para .env
for svc in api-gateway auth-service event-service booking-service \
            payment-service search-service worker-service web; do
  if [ ! -f "apps/$svc/.env" ]; then
    cp "apps/$svc/.env.example" "apps/$svc/.env"
    echo "✓ apps/$svc/.env criado"
  else
    echo "  apps/$svc/.env já existe, mantido"
  fi
done
```

Neste ponto os arquivos têm os valores padrão do `.env.example`. O campo `JWT_PUBLIC_KEY` ainda é um placeholder — ele será preenchido no **Capítulo 4** após gerar o par RSA.

> **Por que não há um `.env` pronto no repo?** Porque `.env` contém segredos (chaves RSA, API keys, senhas de banco). Versionar segredos é a vulnerabilidade OWASP A02 (Cryptographic Failures). O `.env.example` documenta o contrato de configuração sem expor valores reais.

---

## Passo 1.11 — `Makefile`

```makefile
# Makefile — comandos do dia a dia

.PHONY: setup dev dev-services dev-stop dev-status dev-logs \
        build test lint infra-up infra-down \
        db-migrate db-seed gen-keys clean

# ─── Setup inicial (rodar uma vez após clonar o repo) ────────────────────────
# Cria os .env de todos os serviços a partir dos .env.example
# As chaves RSA são preenchidas no Cap 04 (make gen-keys)
setup:
	@for svc in api-gateway auth-service event-service booking-service \
	             payment-service search-service worker-service web; do \
	  if [ ! -f "apps/$$svc/.env" ]; then \
	    cp "apps/$$svc/.env.example" "apps/$$svc/.env"; \
	    echo "✓ apps/$$svc/.env criado"; \
	  else \
	    echo "  apps/$$svc/.env já existe"; \
	  fi; \
	done

# Gera par RSA 4096-bit e distribui as chaves para todos os .env
# Requer: openssl + python3 instalados
# O script Python garante que as chaves ficam em formato single-line com \n literal
# (dotenv interpreta \n como newline — multiline real não funciona em .env)
gen-keys:
	@echo "🔑 Gerando par de chaves RSA 4096-bit para o auth-service..."
	@openssl genrsa -out /tmp/showpass_private.pem 4096 2>/dev/null
	@openssl rsa -in /tmp/showpass_private.pem -pubout -out /tmp/showpass_public.pem 2>/dev/null
	@python3 scripts/gen-keys.py
	@rm -f /tmp/showpass_private.pem /tmp/showpass_public.pem
	@echo "✅ Chaves RSA geradas e distribuídas para todos os serviços"

# ─── Desenvolvimento ──────────────────────────────────────────────────────────

# Inicia os serviços NestJS implementados no capítulo atual em background (hot reload)
# Os serviços rodam diretamente com Node.js — sem container (mais rápido para iterar)
dev-services:
	@bash scripts/dev.sh start

dev-stop:
	@bash scripts/dev.sh stop

dev-status:
	@bash scripts/dev.sh status

dev-logs:
	@bash scripts/dev.sh logs

# Sobe infra + todos os serviços via Turborepo (modo watch — sem background)
dev: infra-up
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
	pnpm --filter @showpass/auth-service  run db:seed   # planos SaaS (free/pro/enterprise)
	pnpm --filter @showpass/event-service run db:seed   # categorias de eventos e planos

db-studio:
	pnpm --filter @showpass/$(SERVICE) run db:studio

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

## Passo 1.12 — Arquivos de configuração do workspace

### `.npmrc` — hoisting de pacotes Prisma

```ini
# .npmrc (raiz do monorepo)
#
# Prisma gera código em node_modules/.prisma/<service> e acessa
# @prisma/client-runtime-utils via CJS require(). Com o isolamento
# padrão do pnpm, esse require() falha porque o pacote está no
# virtual store mas não no node_modules raiz.
#
# public-hoist-pattern eleva os pacotes @prisma/* para o node_modules
# raiz — resolve o erro "Cannot find module '@prisma/client-runtime-utils'"
public-hoist-pattern[]=@prisma/*
```

### `.swcrc` — compilador SWC para NestJS

```json
{
  "jsc": {
    "target": "es2022",
    "parser": {
      "syntax": "typescript",
      "decorators": true,
      "dynamicImport": true
    },
    "transform": {
      "legacyDecorator": true,
      "decoratorMetadata": true
    },
    "keepClassNames": true
  },
  "sourceMaps": "inline"
}
```

> **Por que SWC e não tsx/esbuild?**  
> NestJS usa `emitDecoratorMetadata` para injeção de dependências (DI). O `tsx` (baseado em esbuild) **não suporta** essa flag — os decorators são removidos em tempo de compilação e o NestJS cria instâncias com parâmetros `undefined`. O SWC suporta `decoratorMetadata: true` nativamente.  
> O loader `@swc-node/register/esm` é usado no script `dev`: `node --watch --loader @swc-node/register/esm src/main.ts`.

### `"type": "module"` em todos os `package.json` dos serviços

Cada `apps/<service>/package.json` e `packages/<lib>/package.json` precisa de:

```json
{
  "type": "module"
}
```

Sem isso, o `@swc-node/register/esm` resolve arquivos `.ts` como `commonjs` (não como ESM), e o Node.js lança `SyntaxError: does not provide an export named 'AppModule'`.

### `scripts/gen-keys.py` — geração de chaves RSA

O script Python gera o par de chaves RSA 4096-bit e as salva nos `.env` no formato correto para o dotenv:

- As chaves PEM têm quebras de linha reais — dotenv lê apenas a primeira linha de valores sem aspas
- O script usa `"\\n".join(...)` para colapsar em uma linha com `\n` literais
- O dotenv converte `\n` literal → newline real quando carrega a variável
- As entradas são escritas entre aspas duplas: `JWT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n..."`

### `scripts/dev.sh` — inicialização dos serviços em background

```bash
# Inicia auth-service (3006), event-service (3003) e api-gateway (3000) em background
./scripts/dev.sh start

# Parar todos
./scripts/dev.sh stop

# Ver status (PID + porta de cada serviço)
./scripts/dev.sh status

# Logs de todos os serviços
./scripts/dev.sh logs

# Logs de um serviço específico (tail -f)
./scripts/dev.sh logs auth-service
```

Os logs ficam em `/tmp/showpass-logs/`. Equivalentes via Makefile: `make dev-services`, `make dev-stop`, `make dev-status`.

---

## Passo 1.14 — Estrutura de um App NestJS (padrão do monorepo)

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

## Passo 1.15 — CI/CD desde o Dia 1

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

## Passo 1.16 — Proteger a branch main no GitHub

> **Por que é obrigatório?**
> Sem proteção, qualquer membro do time (ou você mesmo num momento de descuido) pode fazer `git push origin main` direto — pulando CI, code review e testes. Isso é o tipo de acidente que derruba produção às 23h de sexta-feira.
>
> O GitHub tem dois sistemas de proteção. Usamos o mais moderno: **Rulesets** (Settings → Rules → Rulesets).

### Passo a passo no GitHub

1. Acesse o repositório no GitHub
2. Vá em **Settings → Rules → Rulesets → New branch ruleset**
3. Configure os campos:

| Campo | Valor |
|---|---|
| **Ruleset name** | `main-protection` |
| **Enforcement status** | `Active` ← **crítico**: se ficar `Disabled` a regra não funciona |
| **Target branches** | Clique em **Add target** → selecione **Default** (main) |

4. Em **Branch rules**, marque:

| Regra | Por que |
|---|---|
| ☑ **Restrict deletions** | Impede deletar a branch main acidentalmente |
| ☑ **Require a pull request before merging** | Todo código entra via PR — sem push direto |
| Required approvals: **0** | OK para projeto solo; em equipe coloque 1+ |
| ☑ **Block force pushes** | Impede `git push --force` na main — preserva histórico |

5. Em **Allowed merge methods**, deixe: `Merge`, `Squash`, `Rebase`
6. Clique em **Create**

> **Nota:** O **Require status checks to pass** (que obriga o CI a passar antes do merge) será ativado no **Capítulo 15** quando o pipeline de CI/CD estiver completo. Por enquanto deixe desmarcado — os workflows ainda não existem no repositório remoto.

Com essa configuração, qualquer `git push origin main` será rejeitado:

```
! [remote rejected] main -> main (protected branch hook declined)
error: failed to push some refs to 'github.com:seu-usuario/showpass'
```

---

## Passo 1.17 — Fluxo de trabalho com branches

A partir de agora, **todo trabalho é feito em branches**. Nenhum commit vai direto na main.

```
main (protegida — não aceita push direto)
  │
  ├── feat/cap02-shared-packages   ← Capítulo 2
  │     └── commits → PR → merge
  │
  ├── feat/cap03-api-gateway       ← Capítulo 3
  │     └── commits → PR → merge
  │
  ├── feat/cap04-auth-service      ← Capítulo 4
  │     └── commits → PR → merge
  │
  └── ...e assim por diante
```

### Fluxo por capítulo

```bash
# 1. Partir sempre da main atualizada
git checkout main
git pull

# 2. Criar branch para o capítulo
git checkout -b feat/cap02-shared-packages

# 3. Implementar o capítulo (vários commits pequenos)
git add .
git commit -m "feat: add @showpass/types package with Zod schemas"

git add .
git commit -m "feat: add @showpass/redis package with Lua scripts"

git add .
git commit -m "feat: add @showpass/kafka module"

# 4. Push da branch para o GitHub
git push -u origin feat/cap02-shared-packages

# 5. Abrir Pull Request via GitHub CLI
gh pr create \
  --title "feat: shared packages e Prisma schemas" \
  --body "Capítulo 2 — @showpass/types, @showpass/redis, @showpass/kafka e Prisma por bounded context"

# 6. Após review, fazer merge via GitHub (botão na interface)
#    Ou via CLI (squash = um commit limpo por feature):
gh pr merge --squash

# 7. Voltar para main atualizada e deletar a branch local
git checkout main
git pull
git branch -d feat/cap02-shared-packages
```

### Convenção de nomes de branches

| Tipo | Padrão | Exemplo |
|---|---|---|
| Feature / Capítulo | `feat/cap{NN}-descricao` | `feat/cap02-shared-packages` |
| Bug fix | `fix/descricao` | `fix/redis-lock-ttl` |
| Infra / CI | `chore/descricao` | `chore/update-docker-compose` |
| Documentação | `docs/descricao` | `docs/adr-kafka-async` |

### Conventional Commits — padrão de mensagens

O workflow `pr-title.yml` valida que o **título do PR** segue este padrão. Use também nos commits:

| Prefixo | Quando usar |
|---|---|
| `feat:` | Nova funcionalidade ou capítulo |
| `fix:` | Correção de bug |
| `chore:` | Manutenção, CI, atualização de deps |
| `docs:` | Documentação, ADRs, READMEs |
| `test:` | Testes (sem mudar código de produção) |
| `refactor:` | Refatoração sem mudança de comportamento |
| `perf:` | Melhoria de performance |
| `ci:` | Mudanças no pipeline CI/CD |

### Commits esperados por capítulo

```
feat/cap01-ambiente:
  feat: initialize Turborepo monorepo with pnpm workspaces
  feat: add Docker Compose with isolated networks (public/private/data)
  feat: add TypeScript strict base config shared across all apps
  feat: add ESLint v9 flat config with eslint-plugin-security
  feat: add NestJS app skeletons with Dockerfiles
  chore: add GitHub Actions CI pipeline (lint, type-check, tests)
  chore: add branch protection ruleset via GitHub Rulesets

feat/cap02-shared-packages:
  feat: add @showpass/types with Zod schemas for events, bookings, payments
  feat: add @showpass/redis with acquireLock/releaseLock Lua scripts
  feat: add @showpass/kafka module with typed producer
  feat: add Prisma schemas per bounded context

feat/cap03-api-gateway:
  feat: add API Gateway with JWT RS256 middleware
  feat: add rate limiting (Throttler) per IP
  feat: add Helmet.js security headers (OWASP A05)
  feat: add virtual waiting queue for high-demand events

feat/cap04-auth-service:
  feat: add auth service with JWT RS256 + refresh token rotation
  feat: add OrganizerGuard and BuyerGuard
  feat: add bcrypt with cost factor 12 (OWASP A02)
  feat: store refresh token as SHA-256 hash

...e assim por diante
```

---

## Testando na prática

Neste capítulo não há serviços HTTP ainda — mas você pode verificar que toda a infraestrutura sobe corretamente.

### O que precisa estar rodando

Apenas o Docker Compose.

### Passo a passo

**0. Setup inicial (uma vez após clonar o repo)**

```bash
pnpm install
make setup      # cria os .env de todos os serviços a partir dos .env.example
```

Os `.env` criados têm valores de desenvolvimento funcional — exceto `JWT_PUBLIC_KEY` e `JWT_PRIVATE_KEY`, que são placeholders até o Cap 04 (`make gen-keys`).

**1. Subir os containers de infraestrutura**

```bash
docker compose up -d
```

Aguarde ~30 segundos para PostgreSQL, Redis, Kafka e Elasticsearch inicializarem.

**2. Verificar que todos os containers subiram**

```bash
docker compose ps
```

Todos devem estar com status `Up` ou `healthy`. Se algum estiver `Exit`, veja os logs:

```bash
docker compose logs <nome-do-container>
```

**3. Testar conectividade com PostgreSQL**

```bash
docker compose exec postgres psql -U showpass -d showpass_auth -c "\l"
```

Você deve ver os bancos `showpass_auth`, `showpass_events`, `showpass_booking` e `showpass_payment` listados.

**4. Testar conectividade com Redis**

```bash
docker compose exec redis redis-cli ping
```

Resposta esperada: `PONG`

**5. Verificar que o Kafka está pronto**

```bash
docker compose exec kafka kafka-topics.sh --bootstrap-server localhost:9092 --list
```

Sem erros = Kafka operacional. A lista pode estar vazia neste ponto (os tópicos são criados pelos serviços).

**6. Verificar build do monorepo**

```bash
pnpm install
pnpm turbo run build
```

Resultado esperado: todos os pacotes compilam sem erro. O Turborepo exibe o tempo de cada task.

**7. Verificar lint**

```bash
pnpm turbo run lint
```

Zero erros = ambiente configurado corretamente.

> **Dica:** Se o `docker compose up` falhar com conflito de porta (ex: porta 5432 já ocupada pelo PostgreSQL local), pare o serviço local antes: `sudo systemctl stop postgresql` no Linux ou pare pelo `brew services` no macOS.

---

## Recapitulando

Neste capítulo você configurou:

1. **Turborepo** com pipeline de build cacheado — builds paralelos e incrementais
2. **Docker Compose** com 3 redes isoladas (public/private/data) — segurança por design
3. **TypeScript strict** como base compartilhada — zero tolerância a `any`
4. **ESLint + eslint-plugin-security** — detecta padrões de injection em tempo de lint
5. **PostgreSQL** com databases separados por serviço — bounded context no nível de dados
6. **Kafka KRaft** — sem ZooKeeper, setup mais simples e moderno
7. **`.npmrc`** com `public-hoist-pattern[]=@prisma/*` — resolve hoisting do Prisma no pnpm
8. **`.swcrc`** com `decoratorMetadata: true` — NestJS DI funciona corretamente (tsx/esbuild não suporta)
9. **`scripts/gen-keys.py`** — geração de chaves RSA 4096-bit no formato correto para dotenv
10. **`scripts/dev.sh`** — inicia/para serviços NestJS em background com hot reload
11. **GitHub Actions CI** — lint, type-check e testes rodam em todo PR
12. **Branch Protection via Rulesets** — push direto na main bloqueado, PRs obrigatórios
13. **Fluxo de branches por capítulo** — convenção de nomes e Conventional Commits
10. **Padrão de diretórios** para serviços NestJS — replicado em todos os `apps/`

---

## Próximo capítulo

[Capítulo 2 → Shared Packages & Prisma](cap-02-shared-packages-prisma.md)
