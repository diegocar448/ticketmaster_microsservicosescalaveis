// packages/types/src/kafka-topics.ts
// Nomes dos tópicos Kafka e schemas dos eventos de domínio.
// Centralizar aqui garante que producer e consumer usem o mesmo contrato
// e que o frontend possa referenciar os tópicos sem depender de @showpass/kafka.
import { z } from 'zod';

export const KAFKA_TOPICS = {
  // Booking domain
  RESERVATION_CREATED: 'bookings.reservation-created',
  RESERVATION_EXPIRED: 'bookings.reservation-expired',
  RESERVATION_CANCELLED: 'bookings.reservation-cancelled',

  // Payment domain
  ORDER_CREATED: 'payments.order-created',
  PAYMENT_CONFIRMED: 'payments.payment-confirmed',
  PAYMENT_FAILED: 'payments.payment-failed',
  REFUND_PROCESSED: 'payments.refund-processed',

  // Event domain (CDC via Debezium)
  EVENT_PUBLISHED: 'events.event-published',
  EVENT_UPDATED: 'events.event-updated',
  EVENT_CANCELLED: 'events.event-cancelled',
} as const;

export type KafkaTopic = (typeof KAFKA_TOPICS)[keyof typeof KAFKA_TOPICS];

// ─── Payloads tipados ─────────────────────────────────────────────────────────

export const PaymentConfirmedEventSchema = z.object({
  orderId: z.uuid(),
  buyerId: z.uuid(),
  organizerId: z.uuid(),
  items: z.array(
    z.object({
      reservationId: z.uuid(),
      ticketBatchId: z.uuid(),
      seatId: z.uuid().nullable(),
      unitPrice: z.number(),
    })
  ),
  paidAt: z.coerce.date(),
});

export type PaymentConfirmedEvent = z.infer<typeof PaymentConfirmedEventSchema>;

export const ReservationCreatedEventSchema = z.object({
  reservationId: z.uuid(),
  buyerId: z.uuid(),
  eventId: z.uuid(),
  expiresAt: z.coerce.date(),
  items: z.array(
    z.object({
      ticketBatchId: z.uuid(),
      seatId: z.uuid().nullable(),
      quantity: z.number().int(),
    })
  ),
});

export type ReservationCreatedEvent = z.infer<typeof ReservationCreatedEventSchema>;
