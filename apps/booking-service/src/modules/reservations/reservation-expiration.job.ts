// Executa a cada 2 minutos — libera reservas que expiraram.
// O Redis expira os locks automaticamente (TTL), mas o banco não.
// Este job sincroniza o banco com o estado do Redis.
//
// Por que processar em chunks?
// Em produção, pode haver milhares de reservas expiradas.
// Processar tudo de uma vez bloquearia o event loop e geraria
// uma query enorme. Chunks de 100 são seguros.

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
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

  // @nestjs/schedule v6 removeu EVERY_2_MINUTES do enum — usar expressão cron literal
  @Cron('*/2 * * * *')
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