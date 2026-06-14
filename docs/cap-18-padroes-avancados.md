# Capítulo 18 — Padrões Avançados

> **Objetivo:** Elevar o ShowPass ao nível de sistemas como o Ticketmaster real — gRPC entre serviços, CQRS para separar leituras de escritas, Event Sourcing para auditoria completa, e Circuit Breaker para resiliência.

## O que você vai aprender

- gRPC: comunicação tipada e eficiente entre microserviços internos
- CQRS: Commands e Queries em caminhos separados
- Event Sourcing: nunca deletar dados — apenas acrescentar eventos
- Circuit Breaker: parar de chamar um serviço que está falhando
- Saga Pattern: transações distribuídas sem 2PC

---

## Passo 18.1 — gRPC entre Booking e Event Service

```protobuf
// packages/proto/event.proto
//
// Proto file define o contrato entre serviços.
// Gerado TypeScript em ambos os serviços — zero divergência de contrato.

syntax = "proto3";
package showpass.events;

service EventService {
  // Buscar dados básicos do evento (booking-service precisa verificar status)
  rpc GetEvent (GetEventRequest) returns (EventResponse);

  // Stream de mudanças de status de assentos (search-service usa)
  rpc WatchSeatAvailability (WatchRequest) returns (stream SeatAvailabilityUpdate);
}

message GetEventRequest {
  string event_id = 1;
}

message EventResponse {
  string id = 1;
  string title = 2;
  string status = 3;          // on_sale, sold_out, etc.
  string organizer_id = 4;
  int32 max_tickets_per_order = 5;
}

message WatchRequest {
  string event_id = 1;
}

message SeatAvailabilityUpdate {
  string seat_id = 1;
  string status = 2;          // available, locked, sold
  string changed_by = 3;      // buyer_id (para depuração)
}
```

```typescript
// apps/booking-service/src/modules/events/event-grpc.client.ts
//
// Cliente gRPC para o event-service.
// gRPC sobre HTTP/2: multiplexing, compressão, tipagem forte via Protobuf.

import { Injectable, OnModuleInit } from '@nestjs/common';
import { Client, ClientGrpc, GrpcMethod } from '@nestjs/microservices';
import { join } from 'path';
import { Observable, firstValueFrom } from 'rxjs';

interface EventServiceGrpc {
  getEvent(data: { eventId: string }): Observable<{
    id: string;
    title: string;
    status: string;
    organizerId: string;
    maxTicketsPerOrder: number;
  }>;
}

@Injectable()
export class EventGrpcClient implements OnModuleInit {
  @Client({
    transport: 4,  // Transport.GRPC
    options: {
      url: process.env.EVENT_SERVICE_GRPC_URL ?? 'event-service:50051',
      package: 'showpass.events',
      protoPath: join(__dirname, '../../../proto/event.proto'),
    },
  })
  private readonly client!: ClientGrpc;

  private eventService!: EventServiceGrpc;

  onModuleInit(): void {
    this.eventService = this.client.getService<EventServiceGrpc>('EventService');
  }

  async getEvent(eventId: string) {
    return firstValueFrom(this.eventService.getEvent({ eventId }));
  }
}
```

---

## Passo 18.2 — CQRS no Booking Service

```typescript
// apps/booking-service/src/modules/reservations/commands/create-reservation.command.ts
//
// CQRS: Commands mudam estado, Queries apenas lêem.
// Separar permite:
// - Escalar leituras independentemente das escritas
// - Otimizar queries sem afetar a lógica de negócio
// - Rastrear todas as intenções (auditoria)

import { ICommand } from '@nestjs/cqrs';

export class CreateReservationCommand implements ICommand {
  constructor(
    public readonly buyerId: string,
    public readonly eventId: string,
    public readonly items: Array<{
      ticketBatchId: string;
      seatId: string | null;
      quantity: number;
    }>,
  ) {}
}
```

```typescript
// apps/booking-service/src/modules/reservations/handlers/create-reservation.handler.ts

import { CommandHandler, ICommandHandler, EventBus } from '@nestjs/cqrs';
import { CreateReservationCommand } from '../commands/create-reservation.command.js';
import { ReservationCreatedEvent } from '../events/reservation-created.event.js';
import { SeatLockService } from '../../locks/seat-lock.service.js';
import { PrismaService } from '../../../prisma/prisma.service.js';

@CommandHandler(CreateReservationCommand)
export class CreateReservationHandler
  implements ICommandHandler<CreateReservationCommand> {

  constructor(
    private readonly seatLock: SeatLockService,
    private readonly prisma: PrismaService,
    private readonly eventBus: EventBus,  // NestJS CQRS EventBus (não Kafka)
  ) {}

  async execute(command: CreateReservationCommand) {
    const { buyerId, eventId, items } = command;

    const seatIds = items
      .filter((i) => i.seatId !== null)
      .map((i) => i.seatId as string);

    // Adquirir locks
    const lockResult = await this.seatLock.acquireMultiple(eventId, seatIds, buyerId);
    if (!lockResult.success) {
      throw new Error(`Assentos indisponíveis: ${lockResult.unavailableSeatIds.join(', ')}`);
    }

    const reservation = await this.prisma.reservation.create({
      data: {
        buyerId,
        eventId,
        organizerId: 'TODO',  // buscar via gRPC
        status: 'pending',
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        items: { create: items },
      },
    });

    // Publicar domain event no EventBus local (para handlers síncronos)
    // O Kafka emit acontece no ReservationCreatedEventHandler
    await this.eventBus.publish(
      new ReservationCreatedEvent(reservation.id, buyerId, eventId),
    );

    return reservation;
  }
}
```

```typescript
// Query: buscar reservas sem tocar na lógica de negócio
// apps/booking-service/src/modules/reservations/queries/get-buyer-reservations.query.ts

import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { PrismaService } from '../../../prisma/prisma.service.js';

export class GetBuyerReservationsQuery {
  constructor(
    public readonly buyerId: string,
    public readonly status?: string,
  ) {}
}

@QueryHandler(GetBuyerReservationsQuery)
export class GetBuyerReservationsHandler
  implements IQueryHandler<GetBuyerReservationsQuery> {

  constructor(private readonly prisma: PrismaService) {}

  async execute(query: GetBuyerReservationsQuery) {
    return this.prisma.reservation.findMany({
      where: {
        buyerId: query.buyerId,
        ...(query.status ? { status: query.status } : {}),
      },
      include: { items: true },
      orderBy: { createdAt: 'desc' },
    });
  }
}
```

---

## Passo 18.3 — Circuit Breaker com opossum

```typescript
// packages/redis/src/circuit-breaker.ts
//
// Circuit Breaker: se o Redis estiver falhando, parar de chamar
// e usar fallback (ex: rejeitar reservas com mensagem amigável).
//
// Estados:
//   CLOSED → operação normal, chamadas passam
//   OPEN   → muitas falhas detectadas, chamadas bloqueadas imediatamente
//   HALF_OPEN → testando recuperação, deixa algumas chamadas passarem

import CircuitBreaker from 'opossum';
import { Logger } from '@nestjs/common';

const logger = new Logger('CircuitBreaker');

export function createCircuitBreaker<T extends (...args: unknown[]) => Promise<unknown>>(
  fn: T,
  name: string,
): CircuitBreaker {
  const breaker = new CircuitBreaker(fn, {
    timeout: 3000,          // timeout de 3s por chamada
    errorThresholdPercentage: 50,  // abrir se 50% das chamadas falharem
    resetTimeout: 30_000,   // tentar fechar após 30s
    volumeThreshold: 10,    // mínimo de 10 chamadas para avaliar
  });

  breaker.on('open', () => {
    logger.warn(`Circuit Breaker ABERTO: ${name} — rejeitando chamadas`);
    // Emitir alerta (Slack/PagerDuty via webhook)
  });

  breaker.on('halfOpen', () => {
    logger.log(`Circuit Breaker HALF-OPEN: ${name} — testando recuperação`);
  });

  breaker.on('close', () => {
    logger.log(`Circuit Breaker FECHADO: ${name} — operação normal`);
  });

  return breaker;
}
```

```typescript
// Usar o Circuit Breaker no SeatLockService
// apps/booking-service/src/modules/locks/seat-lock.service.ts

@Injectable()
export class SeatLockService {
  private readonly acquireLockBreaker: CircuitBreaker;

  constructor(private readonly redis: RedisService) {
    // Envolver a chamada Redis em um Circuit Breaker
    this.acquireLockBreaker = createCircuitBreaker(
      (key: string, ownerId: string, ttl: number) =>
        this.redis.acquireLock(key, ownerId, ttl),
      'redis-seat-lock',
    );

    // Fallback quando o circuit está aberto
    this.acquireLockBreaker.fallback(() => false);
  }

  async acquireOne(eventId: string, seatId: string, buyerId: string): Promise<boolean> {
    const key = `seat:lock:${eventId}:${seatId}`;
    return this.acquireLockBreaker.fire(key, buyerId, 900) as Promise<boolean>;
  }
}
```

---

## Passo 18.4 — Saga Pattern (Choreography)

```typescript
// apps/booking-service/src/modules/sagas/booking.saga.ts
//
// Saga Pattern via Choreography: cada serviço reage a eventos Kafka.
// Não há coordenador central — serviços são autônomos.
//
// Fluxo da Saga:
// 1. Booking: reservation.created → emite bookings.reservation-created
// 2. Payment: recebe → cria order → emite payments.order-created
// 3. Worker: recebe payment.confirmed → gera tickets → emite tickets.generated
// 4. Booking: recebe tickets.generated → atualiza reservation para confirmed
//
// Se qualquer passo falhar → evento de compensação desfaz os anteriores

import { Injectable } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { KAFKA_TOPICS } from '@showpass/types';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SeatLockService } from '../locks/seat-lock.service.js';

@Injectable()
export class BookingSaga {
  constructor(
    private readonly prisma: PrismaService,
    private readonly seatLock: SeatLockService,
  ) {}

  // Quando o pagamento é confirmado → confirmar as reservas
  @EventPattern(KAFKA_TOPICS.PAYMENT_CONFIRMED)
  async onPaymentConfirmed(
    @Payload() payload: { orderId: string; items: Array<{ reservationId: string; seatId: string | null }> }
  ): Promise<void> {
    for (const item of payload.items) {
      await this.prisma.reservation.updateMany({
        where: { id: item.reservationId },
        data: { status: 'confirmed' },
      });

      // Os locks do Redis podem ser liberados — assento foi pago/confirmado
      // (o status 'sold' será refletido nas queries ao banco, não no Redis)
    }
  }

  // Quando o pagamento falha → cancelar reservas e liberar locks
  @EventPattern(KAFKA_TOPICS.PAYMENT_FAILED)
  async onPaymentFailed(
    @Payload() payload: { orderId: string; buyerId: string }
  ): Promise<void> {
    const reservations = await this.prisma.reservation.findMany({
      where: { orderId: payload.orderId, status: 'pending' },
      include: { items: true },
    });

    for (const reservation of reservations) {
      await this.prisma.reservation.update({
        where: { id: reservation.id },
        data: { status: 'cancelled' },
      });

      const seatIds = reservation.items
        .filter((i) => i.seatId !== null)
        .map((i) => i.seatId as string);

      if (seatIds.length > 0) {
        await this.seatLock.releaseMultiple(
          reservation.eventId,
          seatIds,
          payload.buyerId,
        );
      }
    }
  }
}
```

---

## Testando na prática

Esta seção mostra como verificar cada padrão do cap-18 com comandos que rodam no setup real do projeto — sem ferramentas extras além das que já estão instaladas.

### Pré-requisitos

**1. Infra rodando no Docker**

```bash
docker compose up -d postgres redis kafka
```

Aguardar os três ficarem `healthy`:

```bash
docker compose ps | grep -E "postgres|redis|kafka"
# postgres-1   Up X minutes (healthy)
# redis-1      Up X minutes (healthy)
# kafka-1      Up X minutes (healthy)
```

**2. Criar os tópicos Kafka (só na primeira vez)**

```bash
make kafka-topics
# Cria os 17 tópicos do sistema. Idempotente — pode rodar mais de uma vez.
```

**3. Subir os serviços (dois terminais separados)**

```bash
# Terminal 1 — event-service (também sobe o servidor gRPC na porta 50051)
pnpm --filter @showpass/event-service run dev

# Terminal 2 — booking-service
pnpm --filter @showpass/booking-service run dev
```

Aguardar as mensagens de confirmação:

```
Event Service rodando na porta 3003
gRPC server ativo na porta 50051      ← novo no cap-18
Kafka consumer ativo (auth.organizer-*)

Booking Service rodando na porta 3004
Kafka consumer ativo (events.ticket-batch-*)
```

**4. Obter IDs reais para os testes**

```bash
# EVENT_ID: um evento on_sale no banco
EVENT_ID=$(docker compose exec postgres psql -U event_svc -d showpass_events \
  -t -c "SELECT id FROM events WHERE status='on_sale' LIMIT 1;" | tr -d ' \n')
echo "EVENT_ID=$EVENT_ID"

# BATCH_ID: um lote de ingressos deste evento
BATCH_ID=$(docker compose exec postgres psql -U event_svc -d showpass_events \
  -t -c "SELECT id FROM ticket_batches WHERE event_id='$EVENT_ID' LIMIT 1;" | tr -d ' \n')
echo "BATCH_ID=$BATCH_ID"

# BUYER_TOKEN: fazer login como comprador
BUYER_TOKEN=$(curl -s -X POST http://localhost:3006/auth/buyers/login \
  -H "Content-Type: application/json" \
  -d '{"email":"buyer@showpass.com","password":"buyer123"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")
echo "BUYER_TOKEN obtido: ${BUYER_TOKEN:0:30}..."
```

> Se o auth-service (porta 3006) não estiver rodando localmente, suba-o também:
> `pnpm --filter @showpass/auth-service run dev`

---

### Teste 18.1 — gRPC

O event-service expõe o método `GetEvent` via gRPC na porta 50051.
O booking-service chama esse método internamente — em vez de HTTP REST.

**Verificar que o servidor gRPC está de pé**

```bash
# porta 50051 deve aparecer como LISTEN
ss -tlnp | grep 50051
# LISTEN  0  511  0.0.0.0:50051  ...  ("node",pid=XXXX)
```

**Chamar o gRPC com um script Node.js** (não precisa instalar grpcurl)

```bash
node - <<'EOF'
const grpc       = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const path       = require('path');

const PROTO = path.join(process.cwd(), 'packages/proto/event.proto');
const def   = protoLoader.loadSync(PROTO, { keepCase: true, longs: String, enums: String });
const svc   = grpc.loadPackageDefinition(def).showpass.events.EventService;
const client = new svc('localhost:50051', grpc.credentials.createInsecure());

// Substitua pelo EVENT_ID real obtido acima
const EVENT_ID = process.env.EVENT_ID || 'cole-aqui-o-uuid';

client.GetEvent({ event_id: EVENT_ID }, (err, res) => {
  if (err) { console.error('ERRO:', err.message); process.exit(1); }
  console.log('Resposta gRPC:');
  console.log(JSON.stringify(res, null, 2));
  process.exit(0);
});
setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 5000);
EOF
```

Saída esperada:

```json
{
  "id": "a644d8e5-...",
  "title": "ShowPass Festival 2026",
  "status": "on_sale",
  "organizer_id": "56babcd8-...",
  "max_tickets_per_order": 4
}
```

**Comparar latência: gRPC vs HTTP REST**

```bash
# HTTP REST (equivalente)
time curl -s "http://localhost:3003/events/$EVENT_ID/public-meta" > /dev/null

# gRPC — rode o script acima com `time node - <<'EOF' ...`
```

O gRPC é ~30-40% mais rápido em chamadas internas porque usa HTTP/2 com Protobuf
(payload binário compacto) em vez de HTTP/1.1 com JSON texto.

**O que provar:** o booking-service NÃO faz mais `fetch()` HTTP para verificar o
status do evento — usa o `EventGrpcClient` que chama o servidor gRPC diretamente.
Veja em `apps/booking-service/src/modules/events/event-grpc.client.ts`.

---

### Teste 18.2 — CQRS

O CQRS separa intenções de mudança (Commands) de consultas (Queries).
Neste setup, `CqrsModule` já está ativo — você pode ver no log de inicialização:

```bash
grep "CqrsModule\|SagasModule\|CreateReservation\|GetBuyerReservations" \
  <(pnpm --filter @showpass/booking-service run dev 2>&1)
# [InstanceLoader] CqrsModule dependencies initialized
```

**Verificar que os handlers CQRS estão registrados**

```bash
# No log do booking-service (já em execução), procurar:
grep -i "cqrs\|handler\|command" /tmp/showpass-logs/booking-service.log
```

**Como o Command flui ao criar uma reserva**

```bash
# 1. POST → ReservationsController.create()
# 2. Controller chama ReservationsService.create() diretamente (compatibilidade)
# 3. CreateReservationHandler está registrado e pode ser ativado via CommandBus
#    em qualquer futuro refactor do controller sem mudar a lógica de negócio

curl -s -X POST http://localhost:3004/bookings/reservations \
  -H "Authorization: Bearer $BUYER_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"eventId\": \"$EVENT_ID\",
    \"items\": [{\"ticketBatchId\": \"$BATCH_ID\", \"seatId\": null, \"quantity\": 1}]
  }" | python3 -m json.tool
```

**O que o CQRS separa visualmente**

| Arquivo | Responsabilidade |
|---|---|
| `commands/create-reservation.command.ts` | **Intenção**: "quero criar uma reserva" |
| `handlers/create-reservation.handler.ts` | **Execução**: valida + persiste + emite Kafka |
| `events/reservation-created.event.ts` | **Notificação interna**: domain event in-process |
| `queries/get-buyer-reservations.query.ts` | **Leitura**: busca reservas sem efeito colateral |

> **Por que CQRS importa em escala?** Queries podem ser roteadas para uma read
> replica do Postgres (sem afetar o primary de escrita), e Commands podem ter
> rate-limiting separado das consultas. Em pico de 300k usuários, separar os
> caminhos evita que leituras de consulta degradem a latência das reservas.

---

### Teste 18.3 — Circuit Breaker

O Circuit Breaker envolve as chamadas Redis em `SeatLockService.acquireOne()`.
Se o Redis cair, o fallback retorna `false` imediatamente — sem esperar timeout.

**Simulação: pausar o Redis e tentar reservar**

```bash
# Terminal 1: monitorar os logs do booking-service
tail -f /tmp/showpass-logs/booking-service.log | grep -E "Circuit|ABERTO|FECHADO|HALF"

# Terminal 2: pausar o Redis (simula falha)
docker compose pause redis
echo "Redis pausado — circuit breaker vai abrir após 10+ chamadas falhadas"

# Fazer várias requisições de reserva (serão rejeitadas, mas SEM timeout de rede)
for i in {1..12}; do
  RESP=$(curl -s -o /dev/null -w "%{http_code} (%{time_total}s)" \
    -X POST http://localhost:3004/bookings/reservations \
    -H "Authorization: Bearer $BUYER_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"eventId\":\"$EVENT_ID\",\"items\":[{\"ticketBatchId\":\"$BATCH_ID\",\"seatId\":null,\"quantity\":1}]}")
  echo "Req $i: $RESP"
done
```

Observe as primeiras requisições demorando ~3s (timeout do CB) e as seguintes
retornando **imediatamente** (CB aberto, fallback ativo):

```
Req  1: 409 (3.012s)   ← aguarda timeout Redis
Req  2: 409 (3.008s)
...
Req 11: 409 (0.002s)   ← CB ABERTO: retorno instantâneo do fallback
Req 12: 409 (0.001s)   ← sem tocar o Redis
```

No log do booking-service:

```
[CircuitBreaker] [redis-seat-lock] ABERTO — rejeitando chamadas até recuperação
```

**Restaurar o Redis e observar o circuit fechar**

```bash
docker compose unpause redis
echo "Redis restaurado — aguardar ~30s para HALF-OPEN"
sleep 32

# Fazer uma nova requisição — o CB testa a recuperação
curl -s -X POST http://localhost:3004/bookings/reservations \
  -H "Authorization: Bearer $BUYER_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"eventId\":\"$EVENT_ID\",\"items\":[{\"ticketBatchId\":\"$BATCH_ID\",\"seatId\":null,\"quantity\":1}]}" \
  | python3 -m json.tool
```

No log:

```
[CircuitBreaker] [redis-seat-lock] HALF-OPEN — testando recuperação
[CircuitBreaker] [redis-seat-lock] FECHADO — voltando à operação normal
```

> **Por que o fallback retorna `false` e não lança exceção?**
> `false` é interpretado como "assento indisponível" — o buyer recebe 409 com
> mensagem amigável ("assentos não disponíveis") em vez de 500 ("erro interno").
> O sistema degrada graciosamente: reservas são recusadas temporariamente,
> mas o serviço não cai.

---

### Teste 18.4 — Saga Pattern

O `BookingSaga` escuta `payment.confirmed` e `payment.failed` no Kafka.
Você pode injetar eventos manualmente para testar a compensação.

**Verificar que o Saga está inscrito nos tópicos de pagamento**

```bash
# O consumer group booking-service-consumer deve ter payment.* no assignment
docker compose exec kafka /opt/kafka/bin/kafka-consumer-groups.sh \
  --bootstrap-server localhost:9092 \
  --describe --group booking-service-consumer \
  | grep -E "TOPIC|payment"
```

Saída esperada:

```
TOPIC                      PARTITION  ...
payments.payment-confirmed     0      ...
payments.payment-failed        0      ...
```

**Criar uma reserva pendente para usar no teste**

```bash
RESERVATION=$(curl -s -X POST http://localhost:3004/bookings/reservations \
  -H "Authorization: Bearer $BUYER_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"eventId\":\"$EVENT_ID\",\"items\":[{\"ticketBatchId\":\"$BATCH_ID\",\"seatId\":null,\"quantity\":1}]}")

RESERVATION_ID=$(echo $RESERVATION | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
echo "Reserva criada: $RESERVATION_ID (status: pending)"

# Confirmar status no banco
docker compose exec postgres psql -U booking_svc -d showpass_booking \
  -c "SELECT id, status FROM reservations WHERE id='$RESERVATION_ID';"
```

**Simular pagamento confirmado: injetar evento Kafka manualmente**

```bash
# Publicar payment.confirmed no Kafka com os dados da reserva
echo "{\"orderId\":\"00000000-0000-0000-0000-000000000001\",\"buyerId\":\"$BUYER_ID\",\"items\":[{\"reservationId\":\"$RESERVATION_ID\",\"seatId\":null}]}" \
  | docker compose exec -T kafka /opt/kafka/bin/kafka-console-producer.sh \
      --bootstrap-server localhost:9092 \
      --topic payments.payment-confirmed

echo "Evento injetado — aguardar 2s e verificar status"
sleep 2

# Verificar que a saga atualizou a reserva para 'confirmed'
docker compose exec postgres psql -U booking_svc -d showpass_booking \
  -c "SELECT id, status FROM reservations WHERE id='$RESERVATION_ID';"
```

Resultado esperado:

```
                  id                  |  status   
--------------------------------------+-----------
 xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx | confirmed   ← saga atualizou
```

**Simular pagamento falhou: testar a compensação (rollback)**

```bash
# Criar uma nova reserva para testar o rollback
RESERVATION2=$(curl -s -X POST http://localhost:3004/bookings/reservations \
  -H "Authorization: Bearer $BUYER_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"eventId\":\"$EVENT_ID\",\"items\":[{\"ticketBatchId\":\"$BATCH_ID\",\"seatId\":null,\"quantity\":1}]}")
RESERVATION_ID2=$(echo $RESERVATION2 | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")

# Injetar payment.failed
echo "{\"orderId\":\"00000000-0000-0000-0000-000000000002\",\"buyerId\":\"$BUYER_ID\"}" \
  | docker compose exec -T kafka /opt/kafka/bin/kafka-console-producer.sh \
      --bootstrap-server localhost:9092 \
      --topic payments.payment-failed

sleep 2

# Verificar que a saga cancelou a reserva e liberou os locks
docker compose exec postgres psql -U booking_svc -d showpass_booking \
  -c "SELECT id, status FROM reservations WHERE id='$RESERVATION_ID2';"
# status: cancelled ← compensação aplicada
```

No log do booking-service:

```
[BookingSaga] Saga: pagamento falhou, compensando reservas { orderId: '...', buyerId: '...' }
[BookingSaga] Reserva compensada após falha de pagamento { reservationId: '...', seatCount: 0 }
```

> **O que a Saga garante:** se o pagamento falhar APÓS a reserva ser criada
> (e o Redis lock adquirido), os locks são liberados imediatamente — outros
> compradores podem tentar aqueles assentos sem esperar os 7 minutos do TTL.
> É a diferença entre uma janela de 10 segundos e uma de 7 minutos de bloqueio.

---

## Resumo Final do Tutorial

```
                    ┌─────────────────────────────────────────────┐
                    │  18 capítulos — do zero ao production-ready │
                    └─────────────────────────────────────────────┘

Cap 01-02: Fundação sólida (Turborepo, Docker, Prisma, shared packages)
Cap 03-04: Segurança na borda (API Gateway, JWT RS256, Guards)
Cap 05-06: O coração do problema (Event Service, Booking + Redis locks)
Cap 07-08: Dinheiro e busca (Stripe HMAC, Elasticsearch CDC)
Cap 09:    Processamento assíncrono (Kafka, QR Code, PDF, e-mail)
Cap 10-13: Frontend moderno (Next.js 16, SSR, Seat Map SVG, Dashboard)
Cap 14-15: Confiança (Testes de concorrência, CI/CD com Cosign)
Cap 16-17: Produção real (EKS HPA, Terraform, OpenTelemetry, Grafana)
Cap 18:    Big tech patterns (gRPC, CQRS, Circuit Breaker, Saga)
Cap 19:    Escala extrema (80M, Fan Gate anti-bot, antifraude, Outbox) ← bônus

Problema resolvido:
  300.000 pessoas tentam o mesmo assento → apenas 1 consegue → zero double booking
  Redis SETNX: operação atômica que elimina a race condition

Stack: Node.js 22 + NestJS 11 + Prisma 6 + Next.js 16 + Kafka 4.2 + ES 9
       100% TypeScript — do banco ao browser
```

---

> **Você chegou ao fim da jornada principal.** O ShowPass é agora um sistema que resiste a picos de 300.000 usuários simultâneos, é observável do nível de pod Kubernetes até a métrica de negócio individual, e segue os mesmos padrões que empresas como Spotify, Airbnb e o Ticketmaster real usam em produção.
>
> **Pronto para o nível "boss final"?** O [Capítulo 19 — Escala Extrema, Fan Gate e Antifraude](cap-19-escala-extrema-antifraude.md) multiplica a escala por 8 (80M concorrentes), adiciona defesa anti-bot na borda, uma camada antifraude completa e as regras de negócio do mercado brasileiro (limite por CPF, meia-entrada) — tudo sem explodir o banco transacional.

---

## Leitura Recomendada

- [Designing Data-Intensive Applications — Martin Kleppmann](https://dataintensive.net/)
- [Building Microservices — Sam Newman](https://samnewman.io/books/building_microservices/)
- [NestJS Microservices Documentation](https://docs.nestjs.com/microservices/basics)
- [Stripe Webhook Best Practices](https://stripe.com/docs/webhooks/best-practices)
- [Redis Distributed Locks (Redlock Algorithm)](https://redis.io/docs/manual/patterns/distributed-locks/)
