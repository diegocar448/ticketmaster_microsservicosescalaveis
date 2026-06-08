// apps/booking-service/src/modules/sagas/booking.saga.ts
//
// Saga Pattern via Choreography: cada serviço reage a eventos Kafka autonomamente.
//
// Por que Choreography e não Orchestration?
// Orchestration centraliza o controle em um "saga orchestrator" — ponto único
// de falha e gargalo em escala. Choreography distribui a responsabilidade:
// cada serviço sabe o que fazer quando recebe um evento. Mais resiliente,
// mais fácil de escalar horizontalmente.
//
// Fluxo da Saga de Compra:
// 1. booking:  reservation.created    → emite bookings.reservation-created
// 2. payment:  recebe → cria order    → emite payments.order-created
// 3. payment:  webhook Stripe         → emite payments.payment-confirmed
// 4. booking:  recebe confirmed       → atualiza reservas para 'confirmed' ← AQUI
// 5. worker:   recebe confirmed       → gera ingressos (cap-09)
//
// Compensação (rollback) quando pagamento falha:
// 1. payment:  emite payments.payment-failed
// 2. booking:  recebe failed          → cancela reservas + libera locks ← AQUI

import { Controller, Logger } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { KAFKA_TOPICS } from '@showpass/types';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SeatLockService } from '../locks/seat-lock.service.js';

// Payload mínimo de payment.confirmed (contrato com payment-service)
interface PaymentConfirmedPayload {
  orderId: string;
  buyerId: string;
  items: Array<{
    reservationId: string;
    seatId: string | null;
  }>;
}

// Payload de payment.failed — desencadeia compensação
interface PaymentFailedPayload {
  orderId: string;
  buyerId: string;
}

// @Controller() é necessário para o Kafka microservice transport rotear
// @EventPattern para este class. Mesmo padrão de BuyersConsumer et al.
@Controller()
export class BookingSaga {
  private readonly logger = new Logger(BookingSaga.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly seatLock: SeatLockService,
  ) {}

  /**
   * Passo 4 da saga: pagamento confirmado → confirmar reservas.
   *
   * Idempotência: `updateMany` com status 'pending' garante que reprocessar
   * o mesmo evento (at-least-once delivery) não altera reservas já confirmadas.
   */
  @EventPattern(KAFKA_TOPICS.PAYMENT_CONFIRMED)
  async onPaymentConfirmed(
    @Payload() payload: PaymentConfirmedPayload,
  ): Promise<void> {
    this.logger.log('Saga: pagamento confirmado, atualizando reservas', {
      orderId: payload.orderId,
      itemCount: payload.items.length,
    });

    for (const item of payload.items) {
      await this.prisma.reservation.updateMany({
        where: { id: item.reservationId, status: 'pending' },
        data: { status: 'confirmed' },
      });
      // Nota: os locks Redis permanecem até o TTL expirar.
      // O status 'confirmed' no banco é a fonte de verdade para "assento vendido".
      // O Redis é apenas o mecanismo de checkout — após confirmação, já não importa.
    }
  }

  /**
   * Compensação: pagamento falhou → cancelar reservas e liberar locks.
   *
   * Por que liberar os locks aqui e não esperar o TTL expirar?
   * Os locks têm TTL de 7 minutos. Se o pagamento falhou em 10 segundos,
   * outros compradores ficariam bloqueados por 6min50s desnecessariamente.
   * Compensação imediata = disponibilidade máxima para outros buyers.
   */
  @EventPattern(KAFKA_TOPICS.PAYMENT_FAILED)
  async onPaymentFailed(
    @Payload() payload: PaymentFailedPayload,
  ): Promise<void> {
    this.logger.warn('Saga: pagamento falhou, compensando reservas', {
      orderId: payload.orderId,
      buyerId: payload.buyerId,
    });

    // Buscar reservas pending vinculadas ao orderId
    const reservations = await this.prisma.reservation.findMany({
      where: { orderId: payload.orderId, status: 'pending' },
      include: { items: true },
    });

    for (const reservation of reservations) {
      // 1. Cancelar no banco (transação)
      await this.prisma.reservation.update({
        where: { id: reservation.id },
        data: { status: 'cancelled' },
      });

      // 2. Liberar locks Redis — outros buyers podem tentar estes assentos
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

      this.logger.log('Reserva compensada após falha de pagamento', {
        reservationId: reservation.id,
        seatCount: seatIds.length,
      });
    }
  }
}
