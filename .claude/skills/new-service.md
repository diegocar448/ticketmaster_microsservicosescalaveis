# Skill: Adicionar Novo Serviço NestJS ao Monorepo

Use este checklist ao criar um novo microserviço em `apps/`.

## 1. Estrutura de diretórios

```bash
mkdir -p apps/{nome}-service/src/{modules,common/{filters,pipes,guards},prisma}
mkdir -p apps/{nome}-service/prisma
mkdir -p apps/{nome}-service/test/{unit,e2e}
```

## 2. package.json (copiar de apps/event-service e ajustar)

Dependências obrigatórias:
- `@nestjs/common`, `@nestjs/core`, `@nestjs/platform-express`
- `@showpass/types`, `@showpass/kafka` (se emitir eventos), `@showpass/redis` (se usar locks)
- `@prisma/client: ^7.0.0`, `zod: ^4.0.0`

## 3. Prisma schema mínimo

```prisma
generator client {
  provider = "prisma-client-js"
  output   = "../src/prisma/generated"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

Adicionar ao `infra/docker/postgres/init.sql`:
```sql
CREATE DATABASE showpass_{nome};
CREATE USER {nome}_svc WITH PASSWORD '{nome}_svc_dev';
GRANT ALL PRIVILEGES ON DATABASE showpass_{nome} TO {nome}_svc;
```

## 4. Arquivos obrigatórios

- `src/main.ts` — bootstrap com Helmet, CORS, ValidationPipe, Swagger (não prod)
- `src/app.module.ts` — AppModule com ConfigModule
- `src/prisma/prisma.service.ts` — copiar de event-service (com read-replica support)
- `src/common/filters/http-exception.filter.ts` — sem stack trace em produção
- `src/common/pipes/zod-validation.pipe.ts` — validação com Zod 4
- `CLAUDE.md` — documenta os gotchas do novo serviço

## 5. .env.example

```bash
NODE_ENV=development
PORT=30XX  # próxima porta disponível
SERVICE_NAME={nome}-service
DATABASE_URL="postgresql://{nome}_svc:{nome}_svc_dev@localhost:5432/showpass_{nome}"
JWT_PUBLIC_KEY="..."
KAFKA_BROKERS="localhost:9092"
OTEL_SERVICE_NAME={nome}-service
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
```

## 6. Atualizar

- `docker-compose.yml` — adicionar serviço
- `Makefile` — adicionar ao target `db-migrate`
- `.github/workflows/ci.yml` — adicionar ao matrix de build
- `apps/api-gateway/src/modules/proxy/proxy.controller.ts` — adicionar rota de proxy
- `README.md` — adicionar na tabela de serviços

## 7. CLAUDE.md do novo serviço

Criar `apps/{nome}-service/CLAUDE.md` com:
- Responsabilidade do serviço
- Invariantes críticas
- Arquivos de alto risco
- Dependências externas
