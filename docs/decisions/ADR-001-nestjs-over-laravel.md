# ADR-001: NestJS em vez de Laravel

**Status:** Aceito  
**Data:** 2026-04

## Contexto
O projeto original usava Laravel 13 + PHP. A questão era: faz sentido manter PHP quando o frontend é Next.js (TypeScript)?

## Decisão
Migrar todo o backend para NestJS + TypeScript.

## Justificativas

1. **TypeScript end-to-end** — schemas Zod em `packages/types` são compartilhados entre frontend e todos os serviços. Com PHP, existiriam dois conjuntos de tipos para manter em sincronia.

2. **Kafka nativo** — NestJS tem `@EventPattern` e `ClientKafka` como first-class citizens. Laravel precisaria de um worker PHP separado com bibliotecas de terceiros.

3. **gRPC** — NestJS tem `@nestjs/microservices` com Transport.GRPC. PHP não tem suporte gRPC maduro.

4. **Turborepo monorepo** — funciona perfeitamente com workspaces pnpm. PHP não se integra ao ecossistema Node.js de monorepo.

5. **OpenTelemetry** — SDK Node.js com auto-instrumentação para HTTP, Prisma, Redis, Kafka. PHP tem suporte mais limitado.

## Consequências
- Toda a equipe precisa saber TypeScript (não mais PHP)
- Prisma em vez de Eloquent
- NestJS tem mais boilerplate que Laravel (módulos, providers, decorators)
- Ganho: stack única do banco ao browser
