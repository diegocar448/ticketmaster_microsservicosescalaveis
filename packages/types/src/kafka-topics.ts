// packages/types/src/kafka-topics.ts
// Tópicos Kafka e schemas dos eventos de domínio.
// Centralizar aqui garante que producer e consumer usem o mesmo contrato.

// ─── Nomes dos tópicos ────────────────────────────────────────────────────────

export const KAFKA_TOPICS = {
  // Booking
  RESERVATION_CREATED: 'showpass.bookings.reservation-created',
  RESERVATION_EXPIRED: 'showpass.bookings.reservation-expired',

  // Payment
  PAYMENT_CONFIRMED: 'showpass.payments.payment-confirmed',
  PAYMENT_FAILED: 'showpass.payments.payment-failed',

  // Events (CDC via Debezium → search-service indexa)
  EVENT_CREATED: 'showpass.events.event-created',
  EVENT_UPDATED: 'showpass.events.event-updated',
  EVENT_PUBLISHED: 'showpass.events.event-published',
} as const;

export type KafkaTopic = (typeof KAFKA_TOPICS)[keyof typeof KAFKA_TOPICS];
