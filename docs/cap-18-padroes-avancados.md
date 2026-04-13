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
import { CreateReservationCommand } from '../commands/create-reservation.command';
import { ReservationCreatedEvent } from '../events/reservation-created.event';
import { SeatLockService } from '../../locks/seat-lock.service';
import { PrismaService } from '../../../prisma/prisma.service';

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
import { PrismaService } from '../../../prisma/prisma.service';

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
import { PrismaService } from '../../prisma/prisma.service';
import { SeatLockService } from '../locks/seat-lock.service';

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

Problema resolvido:
  300.000 pessoas tentam o mesmo assento → apenas 1 consegue → zero double booking
  Redis SETNX: operação atômica que elimina a race condition

Stack: Node.js 22 + NestJS 11 + Prisma 6 + Next.js 16 + Kafka 4.2 + ES 9
       100% TypeScript — do banco ao browser
```

---

> **Você chegou ao final.** O ShowPass é agora um sistema que resiste a picos de 300.000 usuários simultâneos, é observável do nível de pod Kubernetes até a métrica de negócio individual, e segue os mesmos padrões que empresas como Spotify, Airbnb e o Ticketmaster real usam em produção.

---

## Leitura Recomendada

- [Designing Data-Intensive Applications — Martin Kleppmann](https://dataintensive.net/)
- [Building Microservices — Sam Newman](https://samnewman.io/books/building_microservices/)
- [NestJS Microservices Documentation](https://docs.nestjs.com/microservices/basics)
- [Stripe Webhook Best Practices](https://stripe.com/docs/webhooks/best-practices)
- [Redis Distributed Locks (Redlock Algorithm)](https://redis.io/docs/manual/patterns/distributed-locks/)
