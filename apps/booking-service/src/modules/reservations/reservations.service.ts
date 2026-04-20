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
    // Endpoint "public-meta" — por que não usar GET /events/:id direto?
    // GET /events/:id exige OrganizerGuard (tenant isolation); o buyer não tem
    // os headers x-organizer-id. A rota `/public-meta` devolve só status +
    // organizerId sem dados sensíveis, sem autenticação.
    const base = process.env['EVENT_SERVICE_URL'] ?? 'http://localhost:3003';
    const url = `${base}/events/${eventId}/public-meta`;
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