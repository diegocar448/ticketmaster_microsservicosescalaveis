# Arquitetura ShowPass — Referência Rápida

> Este documento existe para o Claude Code ter contexto arquitetural sem precisar ler os 18 capítulos do tutorial. Para detalhes, ver `docs/cap-XX-*.md`.

## Fluxo principal de compra

```
Usuário → Cloudflare Waiting Room (lotes de 100)
        → Load Balancer
        → API Gateway (JWT RS256, rate limit, fila virtual)
        → Booking Service
            → Redis SETNX (lock 7min TTL)
            → PostgreSQL Primary (INSERT reservation)
            → Kafka: bookings.reservation-created
        → Payment Service
            → Stripe Checkout Session
            → Stripe Webhook (HMAC-SHA256)
            → Kafka: payments.payment-confirmed
        → Worker Service (assíncrono)
            → QR Code (HMAC-SHA256)
            → PDF (Puppeteer)
            → E-mail (Resend SDK)
```

## Serviços e portas (dev)

| Serviço | Porta | Responsabilidade |
|---|---|---|
| api-gateway | 3001 | JWT, rate limit, proxy, fila virtual |
| auth-service | 3002 | Login, tokens RS256, refresh rotation |
| event-service | 3003 | Eventos, venues, planos SaaS |
| booking-service | 3004 | Reservas, Redis locks |
| payment-service | 3005 | Stripe, webhooks, orders |
| search-service | 3006 | Elasticsearch, CDC consumer |
| worker-service | — | Kafka consumer, QR, PDF, e-mail |
| web (Next.js) | 3000 | Frontend |

## Regras de comunicação entre serviços

- **Nunca** acessar o banco de outro serviço diretamente
- **Leitura cross-service:** gRPC (ex: booking → event para verificar status)
- **Eventos de domínio:** Kafka (ex: payment-confirmed → worker gera tickets)
- **API Gateway injeta:** `x-user-id`, `x-user-type`, `x-organizer-id` em todos os requests

## Disponibilidade em produção

| Componente | Estratégia |
|---|---|
| API Gateway / Services | EKS HPA (3→50 pods) |
| PostgreSQL | RDS Multi-AZ + Read-Replica |
| Redis | Cluster Sentinel HA (3 nós) |
| Elasticsearch | 3 nós (1 master + 2 data) |
| Kafka | MSK multi-AZ (3 brokers) |
| Worker | 1 pod grande (4Gi RAM) — vertical |

## Invariantes de negócio

1. Double booking = impossível (Redis SETNX atômico)
2. Assento disponível = `status='available'` no Postgres **E** sem lock no Redis
3. Lock TTL = 7 min (Redis expira) = Reservation TTL = 7 min (job expira no banco)
4. Pagamento = idempotente (SHA-256 hash dos reservation IDs como idempotency key)
5. QR Code = assinado HMAC-SHA256 (impossível forjar sem a chave secreta)
6. Refresh token = armazenado como SHA-256 hash no banco (vazamento não expõe token)
