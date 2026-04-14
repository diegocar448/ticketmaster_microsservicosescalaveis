// packages/types/src/bookings.ts
// Schemas de reservas — compartilhados entre booking-service e frontend

import { z } from 'zod';

// ─── Enums ────────────────────────────────────────────────────────────────────

export const ReservationStatusSchema = z.enum([
  'pending',    // locks Redis ativos, aguardando pagamento
  'confirmed',  // pagamento confirmado, tickets gerados
  'expired',    // TTL expirou sem pagamento
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