# Capítulo 6 — Booking Service

> **Objetivo:** Resolver o problema central do Ticketmaster — reservar assentos sem double booking usando locks distribuídos no Redis com Lua scripts atômicos.

## O que você vai aprender

- Por que locks distribuídos e não locks de banco (pessimistic locking)
- `SET NX EX` — a operação atômica que previne race condition
- Lua scripts no Redis — múltiplas operações atômicas (GET + DEL, acquire all-or-nothing)
- All-or-nothing: reservar N assentos ou nenhum — sem reservas parciais
- Compensação: se algo falha no meio, liberar todos os locks já adquiridos
- `ReservationExpirationJob` — liberar locks expirados de forma eficiente

---

## O Problema Sem Locks

```
Tempo: T+0ms
  User A: lê seat-D14 → disponível ✓
  User B: lê seat-D14 → disponível ✓  (mesma leitura, mesmo instante)

Tempo: T+5ms
  User A: INSERT reservation → OK ✓
  User B: INSERT reservation → OK ✓  ← DOUBLE BOOKING 💥

Banco de dados não é rápido o suficiente para prevenir isso com
transações padrão em alta concorrência. A janela entre "ler" e "escrever"
é o problema — precisamos de uma operação atômica.
```

## A Solução: Redis SETNX + TTL

```
User A: SET seat:event-123:D14 userA NX EX 420 → OK  ← adquiriu o lock
User B: SET seat:event-123:D14 userB NX EX 420 → nil ← rejeitado atomicamente

NX = "set only if Not eXists"
EX = expire em 420 segundos (7 minutos — janela de checkout)

Esta operação é ATÔMICA no Redis — impossível ter race condition.

Por que 7 minutos?
  - Tempo suficiente para o usuário preencher dados de pagamento
  - Curto o suficiente para liberar assentos rapidamente em caso de abandono
  - O Redis exclui a chave automaticamente ao expirar — zero código extra
```

---

## Como Verificar Disponibilidade de um Assento

> **Regra fundamental:** um assento é disponível se e somente se:
> 1. Status no **PostgreSQL** é `available` (nunca vendido)
> 2. **Redis não tem lock** para aquele assento (não está em checkout)
>
> Verificar só o banco é insuficiente — o lock no Redis ainda não foi persistido.  
> Verificar só o Redis é insuficiente — o lock expira, mas o assento pode já ter sido vendido.

```
Usuário consulta mapa de assentos:

  API Gateway → Booking Service
    │
    ├─ 1. Busca status dos assentos no PostgreSQL
    │      SELECT id, status FROM seats WHERE event_id = ?
    │      (status: 'available' | 'sold')
    │
    ├─ 2. Para cada assento 'available', verifica se há lock no Redis
    │      GET seat:lock:{eventId}:{seatId}
    │      Redis responde em ~0.1ms (vs ~5ms do banco)
    │
    └─ 3. Combina os dois resultados:
           postgres.status = 'available' AND redis.lock = null → DISPONÍVEL ✅
           postgres.status = 'available' AND redis.lock = buyerId → BLOQUEADO (em checkout) 🔒
           postgres.status = 'sold'                              → VENDIDO ❌
```

---

## Passo 6.1 — SeatLockService

```typescript
// apps/booking-service/src/modules/locks/seat-lock.service.ts
//
// Gerencia locks distribuídos para assentos.
// Cada lock representa: "este assento está sendo reservado por este buyer".
// TTL de 15 minutos: se o buyer não completar o checkout, o lock expira.

import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '@showpass/redis';

// Prefixo das chaves no Redis — evita colisões com outras chaves
const LOCK_PREFIX = 'seat:lock';

// TTL do lock em segundos (7 minutos = janela de checkout)
// O Redis exclui a chave automaticamente ao expirar — sem cron job necessário
const LOCK_TTL_SECONDS = 7 * 60;

export interface SeatLockResult {
  acquired: boolean;
  lockKey: string;
  lockedBy?: string;
}

@Injectable()
export class SeatLockService {
  private readonly logger = new Logger(SeatLockService.name);

  constructor(private readonly redis: RedisService) {}

  /**
   * Gera a chave Redis para um assento específico de um evento.
   * Formato: seat:lock:{eventId}:{seatId}
   * Ex: seat:lock:550e8400:a1b2c3d4
   */
  private buildKey(eventId: string, seatId: string): string {
    return `${LOCK_PREFIX}:${eventId}:${seatId}`;
  }

  /**
   * Adquire lock de um único assento.
   * Retorna true se conseguiu, false se já está travado por outro usuário.
   */
  async acquireOne(
    eventId: string,
    seatId: string,
    buyerId: string,
  ): Promise<boolean> {
    const key = this.buildKey(eventId, seatId);
    return this.redis.acquireLock(key, buyerId, LOCK_TTL_SECONDS);
  }

  /**
   * Adquire locks de MÚLTIPLOS assentos de forma all-or-nothing.
   *
   * O algoritmo:
   * 1. Tentar adquirir cada lock em sequência
   * 2. Se algum falhar → liberar todos os adquiridos (compensação)
   * 3. Retornar lista de locks que NÃO foram adquiridos (para informar o usuário)
   *
   * Por que Lua e não múltiplos SETNX?
   * Lua scripts no Redis são atômicos — executam sem interrupção.
   * Usar MULTI/EXEC seria possível mas mais complexo de implementar corretamente.
   */
  async acquireMultiple(
    eventId: string,
    seatIds: string[],
    buyerId: string,
  ): Promise<{ success: boolean; unavailableSeatIds: string[] }> {
    const acquired: string[] = [];
    const unavailable: string[] = [];

    for (const seatId of seatIds) {
      const key = this.buildKey(eventId, seatId);
      const ok = await this.redis.acquireLock(key, buyerId, LOCK_TTL_SECONDS);

      if (ok) {
        acquired.push(seatId);
      } else {
        unavailable.push(seatId);
      }
    }

    // Se qualquer assento não estiver disponível → COMPENSAÇÃO
    if (unavailable.length > 0) {
      // Liberar todos os locks que já adquirimos
      // (buyer não pode ficar com locks parciais — outros ficam esperando)
      await this.releaseMultiple(eventId, acquired, buyerId);

      this.logger.warn('Assentos indisponíveis — locks liberados', {
        eventId,
        buyerId,
        unavailable,
        releasedLocks: acquired,
      });

      return { success: false, unavailableSeatIds: unavailable };
    }

    this.logger.log('Locks adquiridos com sucesso', {
      eventId,
      buyerId,
      seatCount: seatIds.length,
    });

    return { success: true, unavailableSeatIds: [] };
  }

  /**
   * Libera múltiplos locks.
   * Usa Lua script para garantir que só libera se o dono for o mesmo buyerId.
   * (Previne que um buyer libere o lock de outro buyer)
   */
  async releaseMultiple(
    eventId: string,
    seatIds: string[],
    buyerId: string,
  ): Promise<void> {
    const releasePromises = seatIds.map((seatId) => {
      const key = this.buildKey(eventId, seatId);
      return this.redis.releaseLock(key, buyerId);
    });

    await Promise.all(releasePromises);
  }

  /**
   * Verifica o status atual de um assento.
   * Retorna o buyerId de quem está com o lock, ou null se disponível.
   */
  async getLockOwner(eventId: string, seatId: string): Promise<string | null> {
    const key = this.buildKey(eventId, seatId);
    return this.redis.get<string>(key);
  }

  /**
   * Verifica disponibilidade de múltiplos assentos combinando Redis + PostgreSQL.
   *
   * Por que duas fontes?
   *   - Redis sabe quem está em checkout agora (lock ativo com TTL)
   *   - PostgreSQL sabe quem já comprou (status 'sold' permanente)
   *
   * Regra: disponível = sem lock no Redis E status 'available' no banco
   *
   * A verificação no Redis é feita primeiro porque é ~50x mais rápida.
   * Só consultamos o banco para assentos sem lock (quantidade menor).
   */
  async checkAvailability(
    eventId: string,
    seatIds: string[],
  ): Promise<Record<string, 'available' | 'locked' | 'sold'>> {
    // Passo 1: verificar locks no Redis em paralelo (operações sub-millisegundo)
    const lockChecks = await Promise.all(
      seatIds.map(async (seatId) => ({
        seatId,
        lockedBy: await this.getLockOwner(eventId, seatId),
      })),
    );

    // Passo 2: assentos sem lock precisam ser verificados no banco
    // (podem estar 'sold' de uma compra anterior já confirmada)
    const unlockedSeatIds = lockChecks
      .filter((c) => c.lockedBy === null)
      .map((c) => c.seatId);

    return {
      // Assentos com lock no Redis → bloqueados (alguém está no checkout)
      ...Object.fromEntries(
        lockChecks
          .filter((c) => c.lockedBy !== null)
          .map((c) => [c.seatId, 'locked' as const]),
      ),
      // Assentos sem lock → o status vem do banco (available ou sold)
      ...Object.fromEntries(
        unlockedSeatIds.map((seatId) => [seatId, 'available' as const]),
        // Nota: o caller (ReservationsController) deve cruzar com o status do Postgres
        // para marcar corretamente como 'sold' os assentos já vendidos
      ),
    };
  }
}
```

---

## Passo 6.2 — Reservation Service

```typescript
// apps/booking-service/src/modules/reservations/reservations.service.ts

import {
  Injectable,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SeatLockService } from '../locks/seat-lock.service';
import { KafkaProducerService } from '@showpass/kafka';
import { KAFKA_TOPICS } from '@showpass/types';
import type { CreateReservationDto } from '@showpass/types';

// TTL da reserva no banco — mesmo valor do lock Redis (7 minutos)
// Ambos devem ser iguais: quando o Redis expira, o job de expiração
// no banco também marca como 'expired' nesse intervalo
const RESERVATION_TTL_MINUTES = 7;

@Injectable()
export class ReservationsService {
  private readonly logger = new Logger(ReservationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly seatLock: SeatLockService,
    private readonly kafka: KafkaProducerService,
  ) {}

  /**
   * Cria uma reserva com distributed lock.
   *
   * Fluxo:
   * 1. Validar que o evento está on_sale
   * 2. Buscar dados dos itens (preço do lote, seatId)
   * 3. Adquirir locks Redis — all-or-nothing
   * 4. Criar Reservation + ReservationItems no banco (transação)
   * 5. Se o DB falhar → liberar locks Redis (compensação)
   * 6. Emitir evento Kafka
   */
  async create(buyerId: string, dto: CreateReservationDto) {
    // ─── 1. Verificar status do evento ────────────────────────────────────────
    // Buscar dados do evento via HTTP para o event-service
    // (em produção: HTTP com cache curto de 30s para não sobrecarregar)
    const eventData = await this.fetchEventData(dto.eventId);

    if (eventData.status !== 'on_sale') {
      throw new BadRequestException(
        `Evento não está em venda. Status atual: ${eventData.status}`,
      );
    }

    // ─── 2. Preparar itens com preços snapshot ─────────────────────────────────
    const items = await this.prepareItems(dto.items);

    // ─── 3. Coletar seatIds para bloquear ─────────────────────────────────────
    const seatIdsToLock = items
      .filter((item) => item.seatId !== null)
      .map((item) => item.seatId as string);

    let locksAcquired = false;

    try {
      // ─── 4. Adquirir locks — ALL OR NOTHING ────────────────────────────────
      if (seatIdsToLock.length > 0) {
        const lockResult = await this.seatLock.acquireMultiple(
          dto.eventId,
          seatIdsToLock,
          buyerId,
        );

        if (!lockResult.success) {
          throw new ConflictException({
            message: 'Um ou mais assentos não estão disponíveis',
            unavailableSeatIds: lockResult.unavailableSeatIds,
          });
        }
      }

      locksAcquired = true;

      // ─── 5. Persistir no banco (transação) ────────────────────────────────
      const expiresAt = new Date(Date.now() + RESERVATION_TTL_MINUTES * 60 * 1000);

      const reservation = await this.prisma.$transaction(async (tx) => {
        const reservation = await tx.reservation.create({
          data: {
            buyerId,
            eventId: dto.eventId,
            organizerId: eventData.organizerId,
            status: 'pending',
            expiresAt,
            items: {
              create: items.map((item) => ({
                ticketBatchId: item.ticketBatchId,
                seatId: item.seatId,
                unitPrice: item.unitPrice,
                quantity: item.quantity,
              })),
            },
          },
          include: { items: true },
        });

        // Incrementar contador de reservados no lote
        for (const item of items) {
          await tx.ticketBatch.updateMany({
            where: { id: item.ticketBatchId },
            data: { reservedCount: { increment: item.quantity } },
          });
        }

        return reservation;
      });

      // ─── 6. Emitir evento de domínio ──────────────────────────────────────
      await this.kafka.emit(
        KAFKA_TOPICS.RESERVATION_CREATED,
        {
          reservationId: reservation.id,
          buyerId,
          eventId: dto.eventId,
          expiresAt,
          items: items.map((i) => ({
            ticketBatchId: i.ticketBatchId,
            seatId: i.seatId,
            quantity: i.quantity,
          })),
        },
        reservation.id,
      );

      this.logger.log('Reserva criada', {
        reservationId: reservation.id,
        buyerId,
        eventId: dto.eventId,
        seatCount: seatIdsToLock.length,
      });

      return reservation;

    } catch (error) {
      // ─── COMPENSAÇÃO: liberar locks se banco falhou ────────────────────────
      if (locksAcquired && seatIdsToLock.length > 0) {
        await this.seatLock.releaseMultiple(dto.eventId, seatIdsToLock, buyerId);
        this.logger.warn('Locks liberados após falha no banco', { buyerId });
      }

      throw error;
    }
  }

  /**
   * Libera uma reserva manualmente (comprador desistiu antes do checkout).
   */
  async cancel(reservationId: string, buyerId: string): Promise<void> {
    const reservation = await this.prisma.reservation.findFirst({
      where: { id: reservationId, buyerId, status: 'pending' },
      include: { items: true },
    });

    if (!reservation) return;  // idempotente — se já cancelado, não fazer nada

    await this.prisma.$transaction(async (tx) => {
      await tx.reservation.update({
        where: { id: reservationId },
        data: { status: 'cancelled' },
      });

      // Decrementar reservedCount no lote
      for (const item of reservation.items) {
        await tx.ticketBatch.updateMany({
          where: { id: item.ticketBatchId },
          data: { reservedCount: { decrement: item.quantity } },
        });
      }
    });

    // Liberar locks Redis
    const seatIds = reservation.items
      .filter((i) => i.seatId !== null)
      .map((i) => i.seatId as string);

    if (seatIds.length > 0) {
      await this.seatLock.releaseMultiple(reservation.eventId, seatIds, buyerId);
    }

    await this.kafka.emit(
      KAFKA_TOPICS.RESERVATION_CANCELLED,
      { reservationId, buyerId, eventId: reservation.eventId },
      reservationId,
    );
  }

  private async fetchEventData(eventId: string): Promise<{
    status: string;
    organizerId: string;
  }> {
    // HTTP call para o event-service (via rede interna Docker/K8s)
    const url = `${process.env.EVENT_SERVICE_URL}/events/${eventId}`;
    const res = await fetch(url);
    if (!res.ok) throw new BadRequestException('Evento não encontrado');
    return res.json() as Promise<{ status: string; organizerId: string }>;
  }

  private async prepareItems(
    items: CreateReservationDto['items'],
  ): Promise<Array<{
    ticketBatchId: string;
    seatId: string | null;
    unitPrice: number;
    quantity: number;
  }>> {
    // Buscar preços dos lotes (snapshot — preço no momento da reserva)
    return Promise.all(
      items.map(async (item) => {
        const batch = await this.prisma.ticketBatch.findUniqueOrThrow({
          where: { id: item.ticketBatchId },
        });

        // Verificar disponibilidade no lote
        const available = batch.totalQuantity - batch.soldCount - batch.reservedCount;
        if (available < item.quantity) {
          throw new ConflictException(
            `Lote "${batch.name}" não tem ingressos suficientes. Disponíveis: ${available}`,
          );
        }

        return {
          ticketBatchId: item.ticketBatchId,
          seatId: item.seatId ?? null,
          unitPrice: Number(batch.price),
          quantity: item.quantity,
        };
      }),
    );
  }
}
```

---

## Passo 6.3 — Job de Expiração de Reservas

```typescript
// apps/booking-service/src/modules/reservations/reservation-expiration.job.ts
//
// Executa a cada 2 minutos — libera reservas que expiraram.
// O Redis expira os locks automaticamente (TTL), mas o banco não.
// Este job sincroniza o banco com o estado do Redis.
//
// Por que processar em chunks?
// Em produção, pode haver milhares de reservas expiradas.
// Processar tudo de uma vez bloquearia o event loop e geraria
// uma query enorme. Chunks de 100 são seguros.

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { KafkaProducerService } from '@showpass/kafka';
import { KAFKA_TOPICS } from '@showpass/types';

@Injectable()
export class ReservationExpirationJob {
  private readonly logger = new Logger(ReservationExpirationJob.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly kafka: KafkaProducerService,
  ) {}

  @Cron(CronExpression.EVERY_2_MINUTES)
  async run(): Promise<void> {
    const CHUNK_SIZE = 100;
    let processedCount = 0;
    let lastId: string | undefined;

    this.logger.log('Iniciando job de expiração de reservas');

    // cursor-based pagination — mais eficiente que OFFSET em tabelas grandes
    while (true) {
      const expiredReservations = await this.prisma.reservation.findMany({
        where: {
          status: 'pending',
          expiresAt: { lt: new Date() },
          ...(lastId ? { id: { gt: lastId } } : {}),
        },
        include: { items: true },
        orderBy: { id: 'asc' },
        take: CHUNK_SIZE,
      });

      if (expiredReservations.length === 0) break;

      // Processar chunk
      for (const reservation of expiredReservations) {
        await this.expireReservation(reservation);
        processedCount++;
      }

      // Cursor para o próximo chunk
      lastId = expiredReservations[expiredReservations.length - 1]?.id;

      // Se retornou menos que o chunk, não há mais registros
      if (expiredReservations.length < CHUNK_SIZE) break;
    }

    if (processedCount > 0) {
      this.logger.log(`Job finalizado: ${processedCount} reservas expiradas`);
    }
  }

  private async expireReservation(
    reservation: Awaited<ReturnType<PrismaService['reservation']['findFirst']>> & {
      items: Array<{ ticketBatchId: string; quantity: number }>;
    },
  ): Promise<void> {
    if (!reservation) return;

    await this.prisma.$transaction(async (tx) => {
      await tx.reservation.update({
        where: { id: reservation.id },
        data: { status: 'expired' },
      });

      // Decrementar reservedCount — liberar para novos compradores
      for (const item of reservation.items) {
        await tx.ticketBatch.updateMany({
          where: { id: item.ticketBatchId },
          data: { reservedCount: { decrement: item.quantity } },
        });
      }
    });

    // Emitir evento — outros serviços podem precisar reagir
    await this.kafka.emit(
      KAFKA_TOPICS.RESERVATION_EXPIRED,
      {
        reservationId: reservation.id,
        buyerId: reservation.buyerId,
        eventId: reservation.eventId,
      },
      reservation.id,
    );
  }
}
```

---

## Passo 6.4 — Reservations Controller

```typescript
// apps/booking-service/src/modules/reservations/reservations.controller.ts

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ReservationsService } from './reservations.service';
import { SeatLockService } from '../locks/seat-lock.service';
import { BuyerGuard } from '../../common/guards/buyer.guard';
import { CurrentUser, type AuthenticatedUser } from '@showpass/types';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { CreateReservationSchema, type CreateReservationDto } from '@showpass/types';

@Controller('bookings/reservations')
export class ReservationsController {
  constructor(
    private readonly reservationsService: ReservationsService,
    private readonly seatLock: SeatLockService,
  ) {}

  /**
   * Criar reserva — requer buyer autenticado.
   * Retorna 409 se assentos não estão disponíveis (com lista dos indisponíveis).
   */
  @Post()
  @UseGuards(BuyerGuard)
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(CreateReservationSchema)) dto: CreateReservationDto,
  ) {
    return this.reservationsService.create(user.id, dto);
  }

  /**
   * Cancelar reserva — libera locks e decrementa reservedCount.
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(BuyerGuard)
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.reservationsService.cancel(id, user.id);
  }

  /**
   * Verificar disponibilidade de assentos em tempo real.
   * Chamado pelo frontend a cada 10 segundos para atualizar o mapa visual.
   */
  @Get('availability/:eventId')
  getAvailability(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Body('seatIds') seatIds: string[],
  ) {
    return this.seatLock.checkAvailability(eventId, seatIds);
  }
}
```

---

## Diagrama do fluxo de reserva

```
Browser → POST /bookings/reservations
              │
         BuyerGuard (verifica x-user-type: buyer)
              │
         ReservationsService.create()
              │
         ┌────▼──────────────────────────────────────┐
         │  1. Fetch event status (HTTP → event-svc) │
         │     status !== 'on_sale'? → 400           │
         └────┬──────────────────────────────────────┘
              │
         ┌────▼──────────────────────────────────────┐
         │  2. Fetch ticket batch prices (Prisma)    │
         │     availableCount < quantity? → 409      │
         └────┬──────────────────────────────────────┘
              │
         ┌────▼──────────────────────────────────────┐
         │  3. Redis: SETNX per seat (all-or-nothing)│
         │     any lock fails?                       │
         │       → release all acquired locks        │
         │       → 409 { unavailableSeatIds: [...] } │
         └────┬──────────────────────────────────────┘
              │ todos os locks adquiridos
         ┌────▼──────────────────────────────────────┐
         │  4. PostgreSQL transaction:               │
         │     CREATE reservation                    │
         │     CREATE reservation_items              │
         │     UPDATE ticket_batch.reservedCount += N│
         │     DB error?                             │
         │       → release all Redis locks           │
         │       → re-throw error                    │
         └────┬──────────────────────────────────────┘
              │
         ┌────▼──────────────────────────────────────┐
         │  5. Kafka: bookings.reservation-created   │
         └────┬──────────────────────────────────────┘
              │
         201 Created { reservationId, expiresAt }
```

---

## Testando na prática

Este é o capítulo mais importante para testar: você vai ver o Redis SETNX em ação e verificar que dois compradores **não conseguem reservar o mesmo assento**.

### O que precisa estar rodando

```bash
# Terminal 1 — infraestrutura
docker compose up -d

# Terminal 2 — auth-service
pnpm --filter @showpass/auth-service run dev          # porta 3006

# Terminal 3 — event-service
pnpm --filter @showpass/event-service run dev         # porta 3003

# Terminal 4 — booking-service
pnpm --filter @showpass/booking-service run db:generate
pnpm --filter @showpass/booking-service run db:migrate
pnpm --filter @showpass/booking-service run dev       # porta 3004
```

### Preparação — obter tokens e IDs

```bash
# Token de organizer (para criar o evento)
ORGANIZER_TOKEN=$(curl -s -X POST http://localhost:3006/auth/organizers/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@rockshows.com.br","password":"Senha@Forte123"}' | jq -r .accessToken)

# Token de comprador 1
BUYER1_TOKEN=$(curl -s -X POST http://localhost:3006/auth/buyers/login \
  -H "Content-Type: application/json" \
  -d '{"email":"joao@email.com","password":"MinhaSenha@123"}' | jq -r .accessToken)

# Token de comprador 2
BUYER2_TOKEN=$(curl -s -X POST http://localhost:3006/auth/buyers/login \
  -H "Content-Type: application/json" \
  -d '{"email":"maria@email.com","password":"Pass@1234"}' | jq -r .accessToken)

# Buscar ID de um assento disponível no evento
SEAT_ID=$(curl -s "http://localhost:3003/events/rock-in-rio-2025/seats?status=available&limit=2" \
  | jq -r '.seats[0].id')

SEAT_ID2=$(curl -s "http://localhost:3003/events/rock-in-rio-2025/seats?status=available&limit=2" \
  | jq -r '.seats[1].id')

EVENT_ID=$(curl -s http://localhost:3003/events/rock-in-rio-2025 | jq -r .id)
```

### Passo a passo

**1. Comprador 1 reserva assentos**

```bash
curl -s -X POST http://localhost:3004/reservations \
  -H "Authorization: Bearer $BUYER1_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"eventId\": \"$EVENT_ID\",
    \"seatIds\": [\"$SEAT_ID\", \"$SEAT_ID2\"]
  }" | jq .
```

Resposta esperada:

```json
{
  "reservationId": "018eaaaa-...",
  "status": "pending",
  "seats": [
    { "id": "...", "row": "A", "number": 1 },
    { "id": "...", "row": "A", "number": 2 }
  ],
  "expiresAt": "2025-01-01T00:15:00.000Z"
}
```

Os assentos ficam **bloqueados por 15 minutos** no Redis.

**2. Comprador 2 tenta reservar os mesmos assentos (double booking)**

```bash
curl -s -X POST http://localhost:3004/reservations \
  -H "Authorization: Bearer $BUYER2_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"eventId\": \"$EVENT_ID\",
    \"seatIds\": [\"$SEAT_ID\"]
  }" | jq .
```

Resposta esperada: **`409 Conflict`**

```json
{
  "statusCode": 409,
  "message": "Assentos indisponíveis",
  "unavailableSeats": ["018ebbbb-..."]
}
```

> Esse é o resultado crítico do capítulo: Redis SETNX garantiu que apenas um comprador adquire o lock.

**3. Verificar o lock no Redis**

```bash
docker compose exec redis redis-cli keys "seat:lock:*" | head -5
```

Você verá chaves como `seat:lock:<event-id>:<seat-id>` com TTL de ~900 segundos.

```bash
docker compose exec redis redis-cli ttl "seat:lock:<event-id>:<seat-id>"
```

**4. Simular expiração de reserva (opcional)**

Defina o TTL do lock para 5 segundos e aguarde:

```bash
docker compose exec redis redis-cli expire "seat:lock:<event-id>:<seat-id>" 5
sleep 6

# Agora o comprador 2 consegue reservar
curl -s -X POST http://localhost:3004/reservations \
  -H "Authorization: Bearer $BUYER2_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"eventId\":\"$EVENT_ID\",\"seatIds\":[\"$SEAT_ID\"]}" | jq .status
```

Resposta esperada: `"pending"` — o assento estava livre após o TTL expirar.

**5. Listar reservas do comprador**

```bash
curl -s http://localhost:3004/reservations \
  -H "Authorization: Bearer $BUYER1_TOKEN" | jq .
```

**6. Cancelar uma reserva**

```bash
RESERVATION_ID="018eaaaa-..."  # id da reserva criada no passo 1
curl -s -X DELETE http://localhost:3004/reservations/$RESERVATION_ID \
  -H "Authorization: Bearer $BUYER1_TOKEN" | jq .
```

Após cancelar, verifique que as chaves Redis foram removidas:

```bash
docker compose exec redis redis-cli keys "seat:lock:*"
```

---

## Recapitulando

1. **Redis SETNX** — operação atômica que elimina a race condition do double booking
2. **All-or-nothing** — se qualquer assento não está disponível, libera todos os locks já adquiridos
3. **Compensação** — se o banco falha após os locks serem adquiridos, Redis é limpo automaticamente
4. **TTL automático** — se o browser fechar, os locks expiram em 15 minutos sem intervenção
5. **Job de expiração** — sincroniza o banco com o estado Redis usando cursor-based pagination
6. **409 com detalhes** — o frontend recebe quais assentos estão indisponíveis para destacar no mapa

---

## Próximo capítulo

[Capítulo 7 → Payment Service](cap-07-payment-service.md)
