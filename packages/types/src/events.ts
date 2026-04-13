// packages/types/src/events.ts
// Schemas de eventos — compartilhados entre event-service, search-service e frontend

import { z } from 'zod';

// ─── Enums ────────────────────────────────────────────────────────────────────

export const EventStatusSchema = z.enum([
  'draft',       // rascunho (organizador editando)
  'published',   // publicado (visível no catálogo)
  'on_sale',     // ingressos à venda
  'sold_out',    // esgotado
  'cancelled',   // cancelado
  'completed',   // evento ocorreu
]);
export type EventStatus = z.infer<typeof EventStatusSchema>;

export const SeatStatusSchema = z.enum([
  'available',  // disponível para compra
  'locked',     // em checkout (lock Redis ativo)
  'sold',       // vendido (permanente no banco)
  'blocked',    // bloqueado pelo organizador
]);
export type SeatStatus = z.infer<typeof SeatStatusSchema>;

// ─── Evento ───────────────────────────────────────────────────────────────────

export const EventSchema = z.object({
  id: z.uuid(),
  title: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  status: EventStatusSchema,
  organizerId: z.uuid(),
  venueId: z.uuid(),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  maxTicketsPerOrder: z.number().int().min(1).max(10),
  imageUrl: z.url().optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type Event = z.infer<typeof EventSchema>;

export const CreateEventSchema = EventSchema.pick({
  title: true,
  description: true,
  venueId: true,
  startsAt: true,
  endsAt: true,
  maxTicketsPerOrder: true,
  imageUrl: true,
});
export type CreateEvent = z.infer<typeof CreateEventSchema>;
