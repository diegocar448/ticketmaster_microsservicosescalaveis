# Arquitetura ShowPass — Referência Visual

> Diagramas renderizados automaticamente no GitHub, VS Code (extensão Mermaid) e Notion.
> Para detalhes de implementação, ver `docs/cap-XX-*.md`.

---

## Diagrama 1 — Arquitetura Completa

```mermaid
flowchart TD
    subgraph INT["🌐 Internet"]
        USERS["👤 Usuários\n(Browser / Mobile)"]
        STRIPE_EXT["💳 Stripe\n(Checkout + Webhooks)"]
    end

    subgraph EDGE["Edge / Frontend"]
        CF["Cloudflare\nWaiting Room + CDN"]
        WEB["Next.js :3001\nFrontend (React / App Router)"]
    end

    subgraph GW_LAYER["API Layer"]
        GW["api-gateway :3000\nJWT RS256 · Rate Limit · Proxy\nx-user-id / x-user-type headers"]
    end

    subgraph SVC["Microserviços"]
        AUTH["auth-service :3006\nLogin · Refresh Rotation\nBcrypt + RS256"]
        EVENT["event-service :3003\ngRPC :50051\nEventos · Venues · Lotes · Planos SaaS"]
        BOOKING["booking-service :3004\nReservas · Redis Locks\nCQRS · Circuit Breaker · Saga"]
        PAYMENT["payment-service :3002\nOrders · Stripe Checkout\nWebhooks HMAC-SHA256"]
        SEARCH["search-service :3005\nBusca Full-text\nElasticsearch CDC"]
        WORKER["worker-service\nQR Code · PDF · E-mail\nKafka Consumer"]
    end

    subgraph DB["Bancos de Dados"]
        USERDB[("PostgreSQL\nshowpass_auth")]
        EVENTDB[("PostgreSQL\nshowpass_events")]
        BOOKINGDB[("PostgreSQL\nshowpass_booking")]
        PAYMENTDB[("PostgreSQL\nshowpass_payment")]
        REDIS[("Redis :6379\nSeat Locks SETNX\nTTL 7 min")]
        ES[("Elasticsearch :9200\nÍndice de Eventos")]
    end

    subgraph MSG["Mensageria"]
        KAFKA[["Apache Kafka\n17 tópicos\nbookings.* · payments.* · events.*"]]
    end

    subgraph OBS["Observabilidade"]
        OTEL["OTEL Collector :4318"]
        PROM["Prometheus :9090"]
        LOKI["Loki :3100"]
        TEMPO["Tempo :3200"]
        GRAFANA["Grafana :3002\nMétricas · Logs · Traces"]
    end

    %% Entrada do usuário
    USERS -->|HTTPS| CF
    USERS -->|HTTPS| WEB
    CF --> GW
    WEB --> GW

    %% Gateway → Serviços (síncrono)
    GW --> AUTH
    GW --> EVENT
    GW --> BOOKING
    GW --> PAYMENT
    GW --> SEARCH

    %% Serviços → Bancos
    AUTH --> USERDB
    EVENT --> EVENTDB
    EVENT --> ES
    BOOKING --> BOOKINGDB
    BOOKING --> REDIS
    PAYMENT --> PAYMENTDB
    SEARCH --> ES
    WORKER --> BOOKINGDB

    %% gRPC interno (booking → event)
    BOOKING -.->|"gRPC :50051\n(Circuit Breaker)"| EVENT

    %% Pagamento externo
    PAYMENT <-->|"HTTPS\nWebhook HMAC-SHA256"| STRIPE_EXT

    %% Kafka — produtores
    BOOKING -->|"bookings.reservation-created\nbookings.reservation-expired"| KAFKA
    PAYMENT -->|"payments.payment-confirmed\npayments.payment-failed\npayments.order-created"| KAFKA
    EVENT -->|"events.event-updated\nevents.ticket-batch-updated"| KAFKA

    %% Kafka — consumidores
    KAFKA -->|"payments.payment-confirmed\npayments.payment-failed"| BOOKING
    KAFKA -->|"payments.payment-confirmed"| WORKER
    KAFKA -->|"events.*"| SEARCH
    KAFKA -->|"auth.organizer-created\nevents.ticket-batch-*"| BOOKING

    %% Observabilidade
    AUTH & EVENT & BOOKING & PAYMENT & SEARCH & WORKER -->|"traces · metrics · logs"| OTEL
    OTEL --> PROM
    OTEL --> LOKI
    OTEL --> TEMPO
    PROM --> GRAFANA
    LOKI --> GRAFANA
    TEMPO --> GRAFANA

    %% Estilos
    classDef service fill:#1e3a5f,stroke:#4a90d9,color:#fff
    classDef db fill:#2d4a1e,stroke:#5a9e3a,color:#fff
    classDef infra fill:#4a2d1e,stroke:#c07a3a,color:#fff
    classDef obs fill:#2d1e4a,stroke:#7a5ac0,color:#fff
    classDef gateway fill:#1e4a3a,stroke:#3ac07a,color:#fff
    classDef external fill:#1a1a2e,stroke:#888,color:#ccc

    class AUTH,EVENT,BOOKING,PAYMENT,SEARCH,WORKER service
    class USERDB,EVENTDB,BOOKINGDB,PAYMENTDB,REDIS,ES db
    class KAFKA infra
    class OTEL,PROM,LOKI,TEMPO,GRAFANA obs
    class GW gateway
    class USERS,STRIPE_EXT,CF,WEB external
```

---

## Diagrama 2 — Fluxo Completo de Compra

```mermaid
sequenceDiagram
    actor Buyer as 🛒 Comprador
    participant GW   as API Gateway
    participant BOOK as Booking Service
    participant REDIS as Redis
    participant GRPC as Event Service (gRPC)
    participant KAFKA as Kafka
    participant PAY  as Payment Service
    participant STRIPE as 💳 Stripe
    participant SAGA as Booking Saga
    participant WORK as Worker Service

    Note over Buyer,WORK: ① Reserva — lock atômico no Redis

    Buyer->>GW: POST /bookings/reservations<br/>{ eventId, items: [{ ticketBatchId, seatId, qty }] }
    GW->>BOOK: proxy + x-user-id / x-user-type
    BOOK->>GRPC: GetEvent(eventId) via gRPC + Circuit Breaker
    GRPC-->>BOOK: { status: "on_sale", maxTicketsPerOrder: 4 }
    BOOK->>REDIS: SETNX seat:lock:{eventId}:{seatId} TTL=420s
    REDIS-->>BOOK: 1 (lock adquirido)
    BOOK->>BOOK: INSERT reservation (status=pending)
    BOOK->>KAFKA: bookings.reservation-created
    BOOK-->>GW: 201 { id, status: "pending", expiresAt }
    GW-->>Buyer: 201 Reserva criada ✅

    Note over Buyer,WORK: ② Checkout — sessão Stripe gerada

    Buyer->>GW: POST /payments/orders<br/>{ reservationIds: ["..."] }
    GW->>PAY: proxy
    PAY->>GW: GET /bookings/reservations/:id<br/>(valida posse — OWASP A01)
    GW-->>PAY: reservation + items enriquecidos
    PAY->>STRIPE: createCheckoutSession(lineItems, metadata)
    STRIPE-->>PAY: { url: "https://checkout.stripe.com/cs_test_..." }
    PAY->>PAY: INSERT order (status=pending)
    PAY-->>Buyer: { checkoutUrl, orderId }

    Note over Buyer,WORK: ③ Pagamento — webhook HMAC-SHA256

    Buyer->>STRIPE: Paga (4242 4242 4242 4242)
    STRIPE-->>PAY: POST /webhooks/stripe<br/>checkout.session.completed + assinatura HMAC
    PAY->>PAY: constructEvent() — valida HMAC
    PAY->>PAY: UPDATE order SET status=paid
    PAY->>KAFKA: payments.payment-confirmed<br/>{ orderId, buyerId, items }
    PAY-->>STRIPE: 200 OK

    Note over Buyer,WORK: ④ Saga Choreography (cap-18)

    KAFKA-->>SAGA: payments.payment-confirmed consumed
    SAGA->>BOOK: UPDATE reservation SET status=confirmed<br/>(idempotente — só atualiza se status=pending)

    Note over Buyer,WORK: ⑤ Worker — ingresso gerado assincronamente

    KAFKA-->>WORK: payments.payment-confirmed consumed
    WORK->>WORK: Gera QR Code (HMAC-SHA256 do ticketId)
    WORK->>WORK: Gera PDF (Puppeteer)
    WORK->>WORK: Upload PDF → Storage S3
    WORK->>BOOK: INSERT ticket (status=issued, pdfUrl=s3://...)
    WORK->>KAFKA: workers.ticket-issued

    Note over Buyer,WORK: ✅ Compra concluída — ingresso disponível no banco
```

---

## Regras de comunicação entre serviços

| Tipo | Protocolo | Quando usar |
|---|---|---|
| **Síncrono crítico** | HTTP/REST via Gateway | Buyer ↔ serviços (requests com JWT) |
| **Síncrono interno** | gRPC (Protobuf, HTTP/2) | booking → event (latência crítica, ~40% mais rápido) |
| **Assíncrono** | Kafka (at-least-once) | Eventos de domínio (confirmação, geração de ticket) |
| **NUNCA** | SQL cross-service | Cada serviço acessa só seu próprio banco |

## Serviços e portas (dev local)

| Serviço | Porta HTTP | Porta gRPC | Banco |
|---|---|---|---|
| api-gateway | 3000 | — | — |
| auth-service | 3006 | — | showpass_auth |
| event-service | 3003 | 50051 | showpass_events |
| booking-service | 3004 | — | showpass_booking |
| payment-service | 3002 | — | showpass_payment |
| search-service | 3005 | — | Elasticsearch |
| worker-service | — | — | showpass_booking (tickets) |
| web (Next.js) | 3001 | — | — |

## Invariantes de negócio

1. **Double booking = impossível** — Redis SETNX atômico (Lua script)
2. **Assento disponível** = `status='available'` no Postgres **E** sem lock no Redis
3. **Lock TTL = 7 min** (Redis expira automaticamente) = Reservation TTL = 7 min (cron job expira no banco)
4. **Pagamento idempotente** — SHA-256 hash dos reservationIds como idempotency key no Stripe
5. **QR Code inforjável** — assinado HMAC-SHA256 com chave secreta do worker
6. **Refresh token seguro** — armazenado como SHA-256 hash no banco (vazamento não expõe o token real)
7. **Saga com compensação** — `payment.failed` cancela reservas e libera locks imediatamente (não espera TTL)
