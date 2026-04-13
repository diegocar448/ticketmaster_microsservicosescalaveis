# ShowPass — Arquitetura Ticketmaster em Produção

> Tutorial completo: do ambiente local ao Kubernetes em produção.  
> Stack 100% TypeScript — NestJS (microserviços) + Next.js 16 + Prisma + Kafka.
>
> Inspirado no vídeo **[ARQUITETANDO O TICKETMASTER NA PRÁTICA | SYSTEM DESIGN](https://www.youtube.com/watch?v=3XSijmIZxXU)** de **Renato Augusto (@RenatoAugustoTech)**.

---

## O Problema que o Ticketmaster Resolve

Imagine que Fulano famosão anuncia uma turnê. Em 60 segundos, **300.000 pessoas** tentam comprar o mesmo assento D14, fileira 5. Sem arquitetura correta:

```
Usuário A lê: assento D14 disponível ✓
Usuário B lê: assento D14 disponível ✓   ← simultaneamente, mesmo assento
Usuário A salva reserva → OK
Usuário B salva reserva → DOUBLE BOOKING 💥
```

Este tutorial constrói o sistema que resolve isso em produção — com locks distribuídos no Redis, eventos assíncronos via Kafka, e escala horizontal no Kubernetes.

---

## Requisitos do Sistema

### Funcionais
1. **Visualização de eventos** — usuários pesquisam e descobrem eventos na plataforma
2. **Pesquisa de eventos** — busca por nome, artista, data, localização e categoria
3. **Compra de ingressos** — fluxo completo: selecionar assento → reservar → pagar → receber QR Code

### Não-Funcionais (o que torna o problema difícil)

| Requisito | Meta | Como o ShowPass resolve |
|---|---|---|
| **Escala** | 10M usuários simultâneos em dias de grandes eventos | HPA no EKS (3→50 pods), Redis distributed locks |
| **Anti-bot / Anti-scalper** | Bots não podem ter vantagem; geolocalização não privilegia ninguém | Fila de espera virtual com token aleatório — F5 não ajuda |
| **Busca inteligente** | Tolerar typos, busca por proximidade e assuntos | Elasticsearch fuzziness AUTO + edge_ngram + geo_distance |
| **Consistência** | 2 usuários tentam o mesmo assento → apenas 1 consegue | Redis SETNX atômico (Lua script) — zero double booking |
| **Latência** | P95 < 100ms para leitura; P95 < 500ms para reserva | Read replicas; cache Redis; índices ES otimizados |
| **Throughput** | Razão leitura:escrita de 100:1 | Search Service independente; CQRS (queries isoladas) |
| **Disponibilidade** | 99.9% uptime (modo alta disponibilidade) | Multi-AZ EKS, RDS Multi-AZ, Redis Replication Group |

---

## Arquitetura

```
  User 1 ─┐
  User 2 ─┼──► Load Balancer ──► Cloudflare (WAF + CDN + Waiting Room)
  User 3 ─┘                              │
                                         │ HTTPS — 100 usuários/vez (fila virtual)
                              ┌──────────▼──────────┐
                              │     API Gateway      │  JWT · Rate Limit · Routing
                              └───┬──────┬───────────┘
                                  │      │          │
           ┌──────────────────────▼─┐  ┌─▼────────┐ ┌▼──────────────────┐
           │     Event Service      │  │ Booking  │ │  Search Service   │
           │  NestJS + Prisma       │  │ Service  │ │  NestJS + ES 9.3  │
           │  Cache-Aside (Redis)   │  │ NestJS   │ │                   │
           └────────────┬───────────┘  └────┬─────┘ └─────────┬─────────┘
                        │ leituras           │                  │
                        │             Reserve│                  │
          ┌─────────────▼──────┐     ┌───────▼──────────────┐  │
          │ PostgreSQL Primary  │     │ Redis Cluster        │  │
          │   (escritas)        │     │ Sentinel HA          │  │
          └─────────────────────┘     │ TTL: 7 min           │  │
          ┌─────────────────────┐     └──────────────────────┘  │
          │ PostgreSQL Read     │◄─── Event Service reads    ◄───┘
          │ Replica (leituras)  │     Redis Cluster Sentinel HA
          └──────────┬──────────┘
                     │ CDC (WAL)
             ┌───────▼──────┐
             │  Debezium 3  │──► Kafka 4.2 (KRaft)
             └──────────────┘         │
                                ┌─────▼──────────────────┐
                                │    Worker Service       │  Escala VERTICAL
                                │  QR Codes · PDF · Email │  (mais RAM/CPU)
                                │  Stripe Webhooks        │  não horizontal
                                └─────────────────────────┘

  ┌─────────────────────────────────────────────────────────────┐
  │  Next.js 16.2 — App Router · SSR · Turbopack · shadcn/ui   │
  └─────────────────────────────────────────────────────────────┘
```

---

## Stack (versões abril/2026)

| Camada | Tecnologia | Versão |
|---|---|---|
| Runtime | Node.js | 22 LTS |
| Backend services | NestJS | 11.x |
| ORM | Prisma | 7.x |
| Frontend | Next.js | 16.2 |
| Linguagem | TypeScript | 6.0 |
| Validação | Zod | 4.x |
| Banco relacional | PostgreSQL | 18.3 |
| Cache / Locks | Redis | 8.6 |
| Search | Elasticsearch | 9.3 |
| Mensageria | Apache Kafka | 4.2 (KRaft) |
| CDC | Debezium | 3.x |
| Payment | Stripe Node SDK | 22.x |
| Monorepo | Turborepo | 2.x |
| Containers | Docker Engine | 29.1.x |
| Orquestração | Kubernetes (EKS) | 1.35 |
| IaC | Terraform | 1.14.8 |
| Observabilidade | OpenTelemetry + Grafana Stack | — |
| CI/CD | GitHub Actions | — |

---

## Estrutura do Monorepo

```
showpass/
├── apps/
│   ├── api-gateway/        # NestJS — ponto de entrada único da API
│   ├── event-service/      # NestJS — eventos, venues, organizers, plans
│   ├── booking-service/    # NestJS — reservas com Redis distributed locks
│   ├── payment-service/    # NestJS — Stripe Checkout + webhooks HMAC
│   ├── search-service/     # NestJS — Elasticsearch full-text + geo
│   ├── worker-service/     # NestJS — Kafka consumers, QR, PDF, e-mail
│   └── web/                # Next.js 16 — frontend comprador + organizer
├── packages/
│   ├── types/              # Zod schemas + TypeScript interfaces (shared)
│   ├── kafka/              # KafkaModule reutilizável entre serviços
│   ├── redis/              # RedisModule reutilizável entre serviços
│   └── ui/                 # shadcn/ui + Tailwind v4 components
├── infra/
│   ├── k8s/                # Kubernetes manifests (Kustomize)
│   └── terraform/          # AWS EKS + RDS + ElastiCache + MSK
├── .github/
│   └── workflows/          # CI/CD pipelines (test, build, deploy)
├── turbo.json              # Pipeline de build cacheado
├── docker-compose.yml      # Ambiente de desenvolvimento completo
├── Makefile                # Comandos do dia a dia
└── package.json            # Root workspace (pnpm)
```

---

## Capítulos

| # | Capítulo | Conceitos-chave |
|---|---|---|
| [01](docs/cap-01-ambiente-monorepo.md) | Ambiente & Monorepo | Turborepo, Docker Compose, TypeScript strict, ESLint/Prettier |
| [02](docs/cap-02-shared-packages-prisma.md) | Shared Packages & Prisma | Zod schemas compartilhados, Prisma por bounded context |
| [03](docs/cap-03-api-gateway.md) | API Gateway | NestJS Gateway, JWT middleware, rate limiting, Helmet (OWASP) |
| [04](docs/cap-04-auth-service.md) | Auth Service | JWT + Refresh Token, Guards, multi-tenant organizer/buyer |
| [05](docs/cap-05-event-service.md) | Event Service | Organizers, Plans (SaaS), Venues, Seat Maps, Events |
| [06](docs/cap-06-booking-service.md) | Booking Service | Redis SETNX + Lua scripts, all-or-nothing seat lock |
| [07](docs/cap-07-payment-service.md) | Payment Service | Stripe Checkout Session, Idempotency Keys, Webhook HMAC |
| [08](docs/cap-08-search-service.md) | Search Service | Elasticsearch 9, CDC via Debezium + Kafka, geo search |
| [09](docs/cap-09-worker-service.md) | Worker Service | Kafka consumers, QR Code HMAC-SHA256, PDF, e-mail |
| [10](docs/cap-10-frontend-foundation.md) | Frontend Foundation | Next.js 16 App Router, Zustand auth, API client Zod-typed |
| [11](docs/cap-11-event-pages-seat-map.md) | Event Pages & Seat Map | SSR, SEO Schema.org, SVG interativo, WebSocket real-time |
| [12](docs/cap-12-checkout-flow.md) | Checkout Flow | Stripe Elements, otimistic UI, tratamento de falhas |
| [13](docs/cap-13-organizer-dashboard.md) | Organizer Dashboard | Server Components, Recharts, export CSV, métricas ao vivo |
| [14](docs/cap-14-testes.md) | Testes | Jest unit, Supertest E2E, Playwright, k6 load test (10k rps) |
| [15](docs/cap-15-cicd.md) | CI/CD | GitHub Actions, Docker multi-stage, push ECR, deploy EKS |
| [16](docs/cap-16-kubernetes-terraform.md) | Kubernetes & Terraform | EKS, HPA, Kustomize overlays, Terraform AWS modules |
| [17](docs/cap-17-observabilidade.md) | Observabilidade | OpenTelemetry traces, Prometheus, Grafana, Loki, alertas |
| [18](docs/cap-18-padroes-avancados.md) | Padrões Avançados | gRPC entre serviços, CQRS, Event Sourcing, Circuit Breaker |

---

## OWASP Top 10 — Como o ShowPass se protege

| OWASP | Risco | Mitigação |
|---|---|---|
| A01 | Broken Access Control | `OrganizerGuard` + `BuyerGuard` no Gateway; tenant isolation por `organizerId` |
| A02 | Cryptographic Failures | bcrypt p/ passwords; HMAC-SHA256 p/ QR Codes e Webhooks; TLS em trânsito |
| A03 | Injection | Prisma parameterized queries; Zod validation em 100% dos DTOs de entrada |
| A04 | Insecure Design | Bounded contexts isolados; serviços sem acesso cruzado ao banco; least privilege |
| A05 | Security Misconfiguration | Helmet.js (CSP, HSTS, X-Frame-Options); `NODE_ENV=production` desativa stack traces |
| A06 | Vulnerable Components | Dependabot + `pnpm audit` no CI; imagens Docker com digest fixado |
| A07 | Auth Failures | Rate limit login 5 req/min; JWT expira em 15min; refresh token rotation |
| A08 | Software Integrity | Cosign assina imagens Docker; SLSA Level 2 no pipeline CI |
| A09 | Logging Failures | OpenTelemetry em todos os serviços; audit log append-only no PostgreSQL |
| A10 | SSRF / Webhooks Falsos | `stripe.webhooks.constructEvent()` valida HMAC antes de qualquer processamento |

---

## Modelo de Dados

```
organizers ──< plans (SaaS tiers)
organizers ──< venues ──< sections ──< seats
organizers ──< events ──< ticket_batches

buyers ──< reservations (Redis lock: 15min TTL)
reservations ──< orders ──< order_items ──< tickets
tickets ── QR Code (HMAC-SHA256 assinado)
```

---

## Quick Start

```bash
# Pré-requisitos: Node.js 22 LTS, Docker Desktop, pnpm 9+

git clone https://github.com/seu-user/showpass
cd showpass
pnpm install

# Subir infra (PostgreSQL 18, Redis 8, Kafka 4.2, Elasticsearch 9)
make infra-up

# Rodar migrations em todos os serviços
make db-migrate

# Seed inicial (planos, categorias, usuário admin)
make db-seed

# Iniciar todos os serviços em modo watch
make dev

# URLs disponíveis:
# Frontend:     http://localhost:3000
# API Gateway:  http://localhost:3001
# Swagger UI:   http://localhost:3001/docs
# Kafka UI:     http://localhost:8080
# Grafana:      http://localhost:3002
```

---

> **Nível:** Engenheiro Sênior / Staff Engineer  
> **Pré-requisitos:** TypeScript intermediário, Docker básico, conceitos de REST API  
> **Duração estimada:** 40–60 horas de implementação guiada
