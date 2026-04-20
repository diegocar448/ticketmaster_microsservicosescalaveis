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

  // Ticket Batch domain — replicado para booking-service manter preço/limite locais.
  // Por que replicar? Para não consultar event-service a cada reserva (latência + acoplamento).
  // Trade-off aceito: eventual consistency (booking pode ver preço antigo por ~segundos).
  TICKET_BATCH_CREATED:  'events.ticket-batch-created',
  TICKET_BATCH_UPDATED:  'events.ticket-batch-updated',
  TICKET_BATCH_DELETED:  'events.ticket-batch-deleted',

  // Auth → Event domain — organizer replicado para event-service manter FK local.
  // Só campos não-sensíveis: passwordHash/role/etc NUNCA trafegam. Auth é o único
  // que sabe sobre autenticação (ver auth-service/CLAUDE.md "Responsabilidade única").
  AUTH_ORGANIZER_CREATED: 'auth.organizer-created',
  AUTH_ORGANIZER_UPDATED: 'auth.organizer-updated',

  // Auth → Booking/Payment domain — buyer replicado para booking-service manter
  // FK local em Reservation.buyerId. Mesmos princípios do organizer:
  // passwordHash/emailVerifiedAt NUNCA trafegam.
  AUTH_BUYER_CREATED: 'auth.buyer-created',
  AUTH_BUYER_UPDATED: 'auth.buyer-updated',
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

// ─── Ticket Batch events (event-service → booking-service) ───────────────────
//
// Contratos versionados: se adicionar campo novo, marcar .optional() para não
// quebrar consumers antigos. Remoção de campo exige migration coordenada.

export const TicketBatchCreatedEventSchema = z.object({
  id: z.uuid(),
  eventId: z.uuid(),
  organizerId: z.uuid(),
  sectionId: z.uuid().nullable(),
  name: z.string(),
  // price vem como string do Postgres (Decimal), coerce para number no consumer
  price: z.coerce.number(),
  totalQuantity: z.number().int(),
  saleStartAt: z.coerce.date(),
  saleEndAt: z.coerce.date(),
  isVisible: z.boolean(),
});

export type TicketBatchCreatedEvent = z.infer<typeof TicketBatchCreatedEventSchema>;

export const TicketBatchUpdatedEventSchema = z.object({
  id: z.uuid(),
  eventId: z.uuid(),
  // Campos opcionais: evento de update pode carregar só os campos alterados
  // mas para simplicidade do tutorial sempre enviamos o snapshot completo
  sectionId: z.uuid().nullable(),
  name: z.string(),
  price: z.coerce.number(),
  totalQuantity: z.number().int(),
  saleStartAt: z.coerce.date(),
  saleEndAt: z.coerce.date(),
  isVisible: z.boolean(),
});

export type TicketBatchUpdatedEvent = z.infer<typeof TicketBatchUpdatedEventSchema>;

export const TicketBatchDeletedEventSchema = z.object({
  id: z.uuid(),
  eventId: z.uuid(),
});

export type TicketBatchDeletedEvent = z.infer<typeof TicketBatchDeletedEventSchema>;

// ─── Organizer events (auth-service → event-service) ─────────────────────────
//
// Replicação assíncrona via Kafka: quando um organizer é criado/atualizado no
// auth-service, o event-service recebe o evento e faz upsert local. Isso permite
// FK em Event.organizerId / Venue.organizerId sem acoplar os dois bancos.
//
// IMPORTANTE: só campos não-sensíveis. passwordHash, role, emailVerifiedAt etc
// NUNCA trafegam — só o auth-service tem autoridade sobre autenticação.
//
// planSlug em vez de planId: plans são seedados em ambos os bancos mas com UUIDs
// diferentes. O consumer resolve slug → planId local antes de fazer o upsert.

export const OrganizerReplicatedEventSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  planSlug: z.string(),  // resolvido para planId local pelo consumer
});

export type OrganizerReplicatedEvent = z.infer<typeof OrganizerReplicatedEventSchema>;

// ─── Buyer events (auth-service → booking-service/payment-service) ───────────
//
// Mesmo padrão do organizer: auth-service é fonte da verdade de autenticação.
// Consumer local faz upsert para manter FK em Reservation.buyerId.
// NUNCA trafegam: passwordHash, emailVerifiedAt, tokens.

export const BuyerReplicatedEventSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  // name opcional no auth-service — buyer pode se registrar só com email
  name: z.string().nullable(),
});

export type BuyerReplicatedEvent = z.infer<typeof BuyerReplicatedEventSchema>;
