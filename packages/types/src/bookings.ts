// packages/types/src/bookings.ts
// Schemas de reservas — compartilhados entre booking-service e frontend

import { z } from 'zod';

// ─── Enums ────────────────────────────────────────────────────────────────────

// Estados reais que o booking-service grava (ver reservations.service.ts e
// reservation-expiration.job.ts): pending → {cancelled|expired}. NÃO existe
// 'confirmed' no fluxo atual: o pagamento confirmado é refletido na ORDER
// (payment-service), não na reservation. Mantido 'confirmed' fora do enum
// para o schema bater com o que a API realmente retorna.
export const ReservationStatusSchema = z.enum([
  'pending',    // locks Redis ativos, aguardando pagamento
  'expired',    // TTL expirou sem pagamento (job de expiração)
  'cancelled',  // cancelado pelo usuário ou sistema
]);
export type ReservationStatus = z.infer<typeof ReservationStatusSchema>;



// ─── Reserva ──────────────────────────────────────────────────────────────────

export const ReserveSeatRequestSchema = z.object({
  eventId: z.uuid(),
  // Validação: mínimo 1, máximo 10 assentos por ordem (regra de negócio)
  seatIds: z.array(z.uuid()).min(1).max(10),
});
export type ReserveSeatRequest = z.infer<typeof ReserveSeatRequestSchema>;

export const ReserveSeatResponseSchema = z.object({
  reservationId: z.uuid(),
  status: ReservationStatusSchema,
  // TTL em segundos — frontend usa para mostrar countdown
  expiresIn: z.number().int().positive(),
  lockedSeats: z.array(z.uuid()),
});
export type ReserveSeatResponse = z.infer<typeof ReserveSeatResponseSchema>;

export const CreateReservationSchema = z.object({
  eventId: z.uuid(),
  items: z.array(
    z.object({
      ticketBatchId: z.uuid(),
      seatId: z.uuid().optional(),
      quantity: z.number().int().min(1).max(10),
    })
  ).min(1).max(10),
});

export type CreateReservationDto = z.infer<typeof CreateReservationSchema>;

// Resposta real de POST e GET /bookings/reservations/:id.
// O GET enriquece cada item com dados das réplicas locais (Event/TicketBatch)
// — ver reservations.controller.ts:findOne. O POST não enriquece (campos de
// enriquecimento ficam ausentes/null), por isso são .optional()/.nullable().
export const ReservationItemResponseSchema = z.object({
  id: z.uuid(),
  reservationId: z.uuid(),
  ticketBatchId: z.uuid(),
  seatId: z.uuid().nullable(),
  unitPrice: z.coerce.number(),
  quantity: z.number().int(),
  // Enriquecimento (presente só no GET):
  ticketBatchName: z.string().optional(),
  seatLabel: z.string().nullable().optional(),
  eventTitle: z.string().optional(),
  thumbnailUrl: z.string().nullable().optional(),
});

export const ReservationResponseSchema = z.object({
  id: z.uuid(),
  buyerId: z.uuid(),
  eventId: z.uuid(),
  organizerId: z.uuid(),
  status: ReservationStatusSchema,
  // expiresAt é a ÚNICA fonte real do countdown de checkout (TTL = 7 min,
  // igual ao lock Redis). O payment-service não devolve expiração.
  expiresAt: z.coerce.date(),
  orderId: z.uuid().nullable(),
  createdAt: z.coerce.date(),
  items: z.array(ReservationItemResponseSchema),
});

export type ReservationResponse = z.infer<typeof ReservationResponseSchema>;