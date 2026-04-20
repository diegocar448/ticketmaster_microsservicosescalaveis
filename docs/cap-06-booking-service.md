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
import { PrismaService } from '../../prisma/prisma.service.js';
import { SeatLockService } from '../locks/seat-lock.service.js';
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
import { PrismaService } from '../../prisma/prisma.service.js';
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
import { ReservationsService } from './reservations.service.js';
import { SeatLockService } from '../locks/seat-lock.service.js';
import { BuyerGuard } from '../../common/guards/buyer.guard.js';
import { CurrentUser, type AuthenticatedUser } from '@showpass/types';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
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

## Passo 6.5 — BuyerGuard e ZodValidationPipe

O controller importa dois utilitários que precisam existir no próprio serviço.

```typescript
// apps/booking-service/src/common/guards/buyer.guard.ts
//
// Protege endpoints exclusivos de compradores.
// Headers são injetados pelo Gateway após validação do JWT.

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import type { Request } from 'express';

@Injectable()
export class BuyerGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();

    const userId = request.headers['x-user-id'];
    const userType = request.headers['x-user-type'];

    if (!userId) {
      throw new UnauthorizedException('Não autenticado');
    }

    if (userType !== 'buyer') {
      throw new ForbiddenException('Acesso exclusivo para compradores');
    }

    return true;
  }
}
```

```typescript
// apps/booking-service/src/common/pipes/zod-validation.pipe.ts
//
// Pipe NestJS que valida o body usando um Zod schema.
// Se inválido: retorna 400 com erros detalhados (mas seguros — não expõe implementação).

import { PipeTransform, Injectable, BadRequestException } from '@nestjs/common';
import type { ZodType } from 'zod';

@Injectable()
export class ZodValidationPipe<T> implements PipeTransform {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);

    if (!result.success) {
      // Zod 4 usa .issues (renomeado de .errors em v3)
      const errors = result.error.issues.map((e) => ({
        field: e.path.join('.'),
        message: e.message,
      }));

      throw new BadRequestException({
        message: 'Dados de entrada inválidos',
        errors,
      });
    }

    return result.data;
  }
}
```

---

## Passo 6.6 — LocksModule

```typescript
// apps/booking-service/src/modules/locks/locks.module.ts
//
// Módulo de locks distribuídos — exporta SeatLockService para ser
// injetado no ReservationsModule sem duplicar a instância do Redis.

import { Module } from '@nestjs/common';
import { SeatLockService } from './seat-lock.service.js';

// RedisModule não é importado aqui porque foi registrado como global
// no AppModule via RedisModule.forRoot() — já disponível para injeção.
@Module({
  providers: [SeatLockService],
  exports: [SeatLockService],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- padrão NestJS
export class LocksModule {}
```

---

## Passo 6.7 — ReservationsModule

```typescript
// apps/booking-service/src/modules/reservations/reservations.module.ts
//
// Módulo de reservas — agrega controller, service, job de expiração
// e as dependências externas (Redis via LocksModule, Kafka, Prisma).

import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service.js';
import { LocksModule } from '../locks/locks.module.js';
import { ReservationsController } from './reservations.controller.js';
import { ReservationsService } from './reservations.service.js';
import { ReservationExpirationJob } from './reservation-expiration.job.js';

// Redis e Kafka não são importados aqui — foram registrados como global
// no AppModule via forRoot(). Já estão disponíveis para injeção.
@Module({
  imports: [
    LocksModule,
    ScheduleModule.forRoot(),
  ],
  controllers: [ReservationsController],
  providers: [ReservationsService, ReservationExpirationJob, PrismaService],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- padrão NestJS
export class ReservationsModule {}
```

---

## Passo 6.8 — AppModule

```typescript
// apps/booking-service/src/app.module.ts
//
// Módulo raiz do Booking Service.
// RedisModule.forRoot() e KafkaModule.forRoot() com global:true —
// disponíveis em todos os módulos filhos sem precisar reimportar.

import { Module } from '@nestjs/common';
import { RedisModule } from '@showpass/redis';
import { KafkaModule } from '@showpass/kafka';
import { ReservationsModule } from './modules/reservations/reservations.module.js';
import { TicketBatchesModule } from './modules/ticket-batches/ticket-batches.module.js';
import { BuyersModule } from './modules/buyers/buyers.module.js';

@Module({
  imports: [
    // Redis global — SeatLockService injeta RedisService sem importar RedisModule novamente
    RedisModule.forRoot({
      host: process.env['REDIS_HOST'] ?? 'localhost',
      port: parseInt(process.env['REDIS_PORT'] ?? '6379', 10),
      password: process.env['REDIS_PASSWORD'],
    }),
    // Kafka global — ReservationsService injeta KafkaProducerService
    KafkaModule.forRoot({
      clientId: process.env['KAFKA_CLIENT_ID'] ?? 'booking-service',
      brokers: (process.env['KAFKA_BROKERS'] ?? 'localhost:29092').split(','),
      groupId: process.env['KAFKA_GROUP_ID'] ?? 'booking-service-group',
    }),
    ReservationsModule,
    // Consumer Kafka: mantém réplica local de TicketBatch atualizada
    TicketBatchesModule,
    // Consumer Kafka: replica buyer do auth-service para satisfazer FK
    // Reservation.buyerId. Dados sensíveis (passwordHash) NUNCA trafegam.
    BuyersModule,
  ],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- padrão NestJS
export class AppModule {}
```

---

## Passo 6.9 — main.ts

```typescript
// apps/booking-service/src/main.ts
// Ponto de entrada do Booking Service — núcleo do anti-double-booking.
// ATENÇÃO: ver apps/booking-service/CLAUDE.md antes de qualquer alteração.
//
// Hybrid app: HTTP (reservations) + Kafka consumer (réplica de TicketBatch).
// O booking-service consome events.ticket-batch-{created,updated,deleted}
// emitidos pelo event-service para manter sua tabela `ticket_batches` sincronizada.
// Por que réplica local em vez de chamada síncrona? No cap-06 precisamos validar
// disponibilidade do lote em milissegundos — uma chamada HTTP cross-service por
// reserva violaria o requisito de latência sob 300k compradores concorrentes.

import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Transport } from '@nestjs/microservices';
import type { MicroserviceOptions } from '@nestjs/microservices';
import { AppModule } from './app.module.js';
import { Logger } from '@nestjs/common';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  // ─── Kafka consumer (hybrid app) ───────────────────────────────────────────
  // connectMicroservice + startAllMicroservices ativa os @EventPattern dos
  // controllers sem precisar de um processo separado.
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.KAFKA,
    options: {
      client: {
        clientId: process.env['KAFKA_CLIENT_ID'] ?? 'booking-service',
        brokers: (process.env['KAFKA_BROKERS'] ?? 'localhost:29092').split(','),
      },
      consumer: {
        // groupId SEPARADO do producer. Em Kafka, cada consumer group recebe
        // sua cópia completa dos eventos — por isso usamos um group distinto
        // do group padrão que o KafkaProducerService pode criar.
        groupId: process.env['KAFKA_CONSUMER_GROUP_ID'] ?? 'booking-service-consumer',
        allowAutoTopicCreation: false,
      },
    },
  });

  await app.startAllMicroservices();

  const port = parseInt(process.env['PORT'] ?? '3004', 10);
  await app.listen(port);
  Logger.log(`Booking Service rodando na porta ${port}`);
  Logger.log('Kafka consumer ativo (events.ticket-batch-*, auth.buyer-*)');
}

void bootstrap();
```

> **Gotcha — `@nestjs/schedule` v6:** o enum `CronExpression.EVERY_2_MINUTES` foi removido nessa versão. Use a expressão cron literal `'*/2 * * * *'` no `@Cron()` decorator do `ReservationExpirationJob`.

> **Gotcha — tópicos precisam existir antes do boot:** com `allowAutoTopicCreation: false`,
> se o consumer não encontrar `events.ticket-batch-*` ou `auth.buyer-*` no broker
> ele derruba o processo com `UNKNOWN_TOPIC_OR_PARTITION`. Siga o mesmo script
> de pré-criação listado em cap-05 (ou em produção, um Init Container no K8s).

### Health endpoint para o readiness do gateway

O `api-gateway` consulta `http://booking-service:3004/health/live` no seu
readiness (cap-03). Adicione o mesmo padrão que foi usado no event-service:

```typescript
// apps/booking-service/src/modules/health/health.controller.ts
import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get('live')
  liveness(): { status: string; service: string } {
    return { status: 'ok', service: 'booking-service' };
  }
}
```

Não precisa checar Redis/Kafka aqui — o liveness responde "o processo está
vivo?". Health check de dependências (readiness) é responsabilidade do gateway.
Importe `HealthModule` no `AppModule` antes dos módulos de feature.

---

## Passo 6.10 — Buyer Replicated Consumer (bounded context)

### Por que o booking-service tem sua própria tabela `buyers`?

`Reservation.buyerId` é FK **local** — sem um registro correspondente em `buyers`, o INSERT da reserva falha com `P2003`. Mas o **dono** do cadastro de buyer é o `auth-service` (ele guarda `passwordHash`, `emailVerifiedAt`, etc.). A solução é o mesmo padrão usado em `event-service` para organizers: **replicação via Kafka** com apenas os campos não-sensíveis.

Princípio OWASP A02: `passwordHash` existe em **um único lugar** — o `auth-service`. Se um atacante comprometer o booking-service, ele encontra `id`, `email`, `name` e nada mais.

### Schema simplificado

O modelo `Buyer` do booking-service já foi ajustado em `cap-02` para refletir o papel de réplica:

```prisma
model Buyer {
  id         String    @id @db.Uuid         // mesmo UUID do auth-service
  email      String    @unique
  name       String?                         // opcional — cadastro pode ser minimal
  lastSyncAt DateTime?                       // quando o último evento Kafka chegou
  createdAt  DateTime  @default(now())
  updatedAt  DateTime  @updatedAt

  reservations Reservation[]

  @@map("buyers")
}
```

**Sem** `passwordHash`, `phone`, `emailVerifiedAt`, `lastLoginAt`. O `id` **não** tem `@default(uuid())` — vem do evento Kafka.

### O consumer

```typescript
// apps/booking-service/src/modules/buyers/buyers.consumer.ts
//
// Mantém a tabela `buyers` local em sincronia com o auth-service. Espelha a
// mesma ideia do OrganizersConsumer em event-service — ver kafka-topics.ts
// e apps/auth-service/CLAUDE.md "Responsabilidade única".
//
// Princípios (idênticos aos do organizer replication):
// 1. Só dados NÃO-sensíveis — passwordHash NUNCA chega aqui (OWASP A02).
// 2. Idempotência via upsert — Kafka re-entrega em caso de crash+restart.
// 3. Consumer não relança erro: payload inválido → log + skip (evita nack
//    infinito bloqueando a partição). Em prod: DLQ.

import { Controller, Logger } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  KAFKA_TOPICS,
  BuyerReplicatedEventSchema,
} from '@showpass/types';

@Controller()
export class BuyersConsumer {
  private readonly logger = new Logger(BuyersConsumer.name);

  constructor(private readonly prisma: PrismaService) {}

  @EventPattern(KAFKA_TOPICS.AUTH_BUYER_CREATED)
  async onCreated(@Payload() rawPayload: unknown): Promise<void> {
    await this.upsertBuyer(rawPayload, 'AUTH_BUYER_CREATED');
  }

  @EventPattern(KAFKA_TOPICS.AUTH_BUYER_UPDATED)
  async onUpdated(@Payload() rawPayload: unknown): Promise<void> {
    await this.upsertBuyer(rawPayload, 'AUTH_BUYER_UPDATED');
  }

  private async upsertBuyer(rawPayload: unknown, topic: string): Promise<void> {
    const parsed = BuyerReplicatedEventSchema.safeParse(rawPayload);
    if (!parsed.success) {
      this.logger.error(`Payload inválido em ${topic}`, { errors: parsed.error.issues });
      return;
    }

    const event = parsed.data;

    await this.prisma.buyer.upsert({
      where: { id: event.id },
      create: {
        id: event.id,
        email: event.email,
        name: event.name,
        lastSyncAt: new Date(),
      },
      update: {
        email: event.email,
        name: event.name,
        lastSyncAt: new Date(),
      },
    });

    this.logger.log(`Buyer replicado (${topic}): id=${event.id}, email=${event.email}`);
  }
}
```

### O módulo

```typescript
// apps/booking-service/src/modules/buyers/buyers.module.ts
//
// Módulo só-consumer: FK Reservation.buyerId consulta esta tabela diretamente
// via PrismaService; não há HTTP aqui.

import { Module } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { BuyersConsumer } from './buyers.consumer.js';

@Module({
  controllers: [BuyersConsumer],
  providers: [PrismaService],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- padrão NestJS
export class BuyersModule {}
```

### Migração (se estiver atualizando de um schema anterior)

Se sua base de dados tem a versão antiga do `Buyer` (com `passwordHash`), rode:

```bash
cd apps/booking-service
pnpm db:migrate --name buyer_replicated_from_auth
```

A migration gerada deve dropar `passwordHash`, `phone`, `emailVerifiedAt`, `lastLoginAt` e adicionar `lastSyncAt`.

### Backfill de buyers existentes (ambiente de dev)

Como Kafka não re-emite eventos históricos automaticamente, buyers criados **antes** da pipeline entrar no ar ficam invisíveis para o booking-service. Em dev, o jeito mais rápido é copiar do auth-service via SQL:

```sql
-- Executar contra showpass_bookings
INSERT INTO buyers (id, email, name, "lastSyncAt", "createdAt", "updatedAt")
SELECT id, email, name, NOW(), "createdAt", NOW()
FROM dblink(
  'host=postgres user=showpass password=showpass dbname=showpass_auth',
  'SELECT id, email, name, "createdAt" FROM buyers'
) AS src(id uuid, email text, name text, "createdAt" timestamptz)
ON CONFLICT (id) DO NOTHING;
```

Em produção o caminho correto é um job de re-emissão no `auth-service` (percorre `buyers` e faz `kafka.emit(AUTH_BUYER_UPDATED, ...)` para cada registro) — **nunca** SQL cross-DB.

### Smoke test ponta-a-ponta

```bash
# 1. Registrar um novo buyer
curl -s -X POST http://localhost:3002/auth/buyer/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"buyer.replica@test.com","password":"SenhaForte123!","name":"Replica Test"}'

# 2. Esperar ~1s para o Kafka propagar, então conferir no booking DB
docker exec -it showpass-postgres psql -U showpass -d showpass_bookings \
  -c "SELECT id, email, \"lastSyncAt\" FROM buyers WHERE email='buyer.replica@test.com';"
```

A linha deve aparecer com `lastSyncAt` preenchido — prova de que o consumer está vivo.

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

### Pré-requisitos — cap-04 (buyers) e cap-05 (evento)

> **IMPORTANTE:** antes de rodar os testes abaixo, você precisa de:
>
> **1. Buyers `diego@email.com` e `george@email.com` registrados** — feito na seção de testes
> do [cap-04](cap-04-auth-service.md). O seed do auth-service cria apenas os planos
> (free/pro/enterprise); os compradores são registrados manualmente via `POST /auth/buyers/register`.
> Se pulou aquela seção, registre agora:
>
> ```bash
> curl -s -X POST http://localhost:3006/auth/buyers/register \
>   -H "Content-Type: application/json" \
>   -d '{"name":"Diego","email":"diego@email.com","password":"MinhaSenha@123"}' | jq .
>
> curl -s -X POST http://localhost:3006/auth/buyers/register \
>   -H "Content-Type: application/json" \
>   -d '{"name":"George","email":"george@email.com","password":"Pass@1234"}' | jq .
> ```
>
> **2. Um evento publicado** — execute todos os passos da seção
> *"Passo a passo — criando um evento end-to-end"* do [cap-05](cap-05-event-service.md).
> Ao final do cap-05 você terá:
> - Um evento com `status=on_sale` e `slug` conhecido (salvo em `$EVENT_SLUG`)
> - Pelo menos um venue com `type=reserved`, seções **Pista** (numbered) e **Cadeira VIP** (reserved)
> - Dois ticket batches (**Pista** e **Cadeira VIP**) — replicados via Kafka para o booking-service
>
> Sem esses pré-requisitos, o login falhará com `401` (buyer inexistente) ou as reservas
> falharão com `400` (evento inexistente) ou `409` (lote não replicado ainda). Se precisar,
> rode `docker compose exec postgres psql -U postgres -d showpass_booking -c 'SELECT id, name
> FROM ticket_batches;'` para confirmar que a replicação Kafka já chegou ao booking-service.

### Preparação — obter tokens e IDs

```bash
# Token de comprador 1
BUYER1_TOKEN=$(curl -s -X POST http://localhost:3006/auth/buyers/login \
  -H "Content-Type: application/json" \
  -d '{"email":"diego@email.com","password":"MinhaSenha@123"}' | jq -r .accessToken)

# Token de comprador 2
BUYER2_TOKEN=$(curl -s -X POST http://localhost:3006/auth/buyers/login \
  -H "Content-Type: application/json" \
  -d '{"email":"george@email.com","password":"Pass@1234"}' | jq -r .accessToken)

# Reaproveitar $EVENT_SLUG do cap-05. Se abriu um novo terminal, exporte novamente:
# export EVENT_SLUG="rock-in-rio-2025-<timestamp>"

# GET /events/:slug/public — rota pública (sem token). Retorna evento completo:
# { id, status, venue: { sections: [{ seats: [...] }] }, ticketBatches: [...] }
EVENT_DATA=$(curl -s "http://localhost:3003/events/$EVENT_SLUG/public")

EVENT_ID=$(echo "$EVENT_DATA" | jq -r '.id')

# IDs dos lotes (precisa para o novo DTO — um reservation item por lote+assento)
BATCH_PISTA_ID=$(echo "$EVENT_DATA" | jq -r '.ticketBatches[] | select(.name=="Pista") | .id')
BATCH_VIP_ID=$(echo   "$EVENT_DATA" | jq -r '.ticketBatches[] | select(.name=="Cadeira VIP") | .id')

# Pegar dois assentos da seção "Pista" (reserved com rows/seats). Se seu venue tiver
# outra ordem de seções, ajuste o índice ou filtre por .name
SEAT_ID=$(echo  "$EVENT_DATA" | jq -r '[.venue.sections[] | select(.name=="Pista")][0].seats[0].id')
SEAT_ID2=$(echo "$EVENT_DATA" | jq -r '[.venue.sections[] | select(.name=="Pista")][0].seats[1].id')

# Confirmar que as variáveis estão preenchidas antes de continuar
echo "EVENT_ID=$EVENT_ID"
echo "BATCH_PISTA_ID=$BATCH_PISTA_ID  BATCH_VIP_ID=$BATCH_VIP_ID"
echo "SEAT_ID=$SEAT_ID  SEAT_ID2=$SEAT_ID2"
```

> **Por que `items[]` em vez de `seatIds[]`?** Um assento só faz sentido dentro de um
> lote específico (preço + regras de venda). O DTO final é
> `items: [{ ticketBatchId, seatId, quantity }]` — o serviço faz snapshot do preço do
> lote no momento da reserva e valida disponibilidade em `totalQuantity - soldCount - reservedCount`.

### Passo a passo

**1. Comprador 1 reserva dois assentos da Pista**

```bash
curl -s -X POST http://localhost:3004/bookings/reservations \
  -H "Authorization: Bearer $BUYER1_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"eventId\": \"$EVENT_ID\",
    \"items\": [
      { \"ticketBatchId\": \"$BATCH_PISTA_ID\", \"seatId\": \"$SEAT_ID\",  \"quantity\": 1 },
      { \"ticketBatchId\": \"$BATCH_PISTA_ID\", \"seatId\": \"$SEAT_ID2\", \"quantity\": 1 }
    ]
  }" | jq .
```

Resposta esperada (`201 Created`):

```json
{
  "id": "018eaaaa-...",
  "buyerId": "...",
  "eventId": "...",
  "organizerId": "...",
  "status": "pending",
  "expiresAt": "2025-01-01T00:07:00.000Z",
  "items": [
    { "ticketBatchId": "...", "seatId": "<SEAT_ID>",  "unitPrice": "200.00", "quantity": 1 },
    { "ticketBatchId": "...", "seatId": "<SEAT_ID2>", "unitPrice": "200.00", "quantity": 1 }
  ]
}
```

Os assentos ficam **bloqueados por 7 minutos** no Redis (`SEAT_LOCK_TTL_SECONDS=420`).

**2. Comprador 2 tenta reservar o mesmo assento (double booking)**

```bash
curl -s -X POST http://localhost:3004/bookings/reservations \
  -H "Authorization: Bearer $BUYER2_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"eventId\": \"$EVENT_ID\",
    \"items\": [
      { \"ticketBatchId\": \"$BATCH_PISTA_ID\", \"seatId\": \"$SEAT_ID\", \"quantity\": 1 }
    ]
  }" | jq .
```

Resposta esperada: **`409 Conflict`**

```json
{
  "statusCode": 409,
  "message": "Um ou mais assentos não estão disponíveis",
  "unavailableSeatIds": ["<SEAT_ID>"]
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
curl -s -X POST http://localhost:3004/bookings/reservations \
  -H "Authorization: Bearer $BUYER2_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"eventId\": \"$EVENT_ID\",
    \"items\": [
      { \"ticketBatchId\": \"$BATCH_PISTA_ID\", \"seatId\": \"$SEAT_ID\", \"quantity\": 1 }
    ]
  }" | jq .status
```

Resposta esperada: `"pending"` — o assento estava livre após o TTL expirar.

**5. Listar reservas do comprador**

```bash
curl -s http://localhost:3004/bookings/reservations \
  -H "Authorization: Bearer $BUYER1_TOKEN" | jq .
```

**6. Cancelar uma reserva**

```bash
RESERVATION_ID="018eaaaa-..."  # id da reserva criada no passo 1
curl -s -X DELETE http://localhost:3004/bookings/reservations/$RESERVATION_ID \
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
