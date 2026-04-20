// packages/types/src/events.ts
//
// Por que Zod e não interfaces TypeScript puras?
// Zod gera tanto o tipo estático (TypeScript) quanto a validação em runtime.
// Um único schema serve no frontend (validar resposta da API) e
// no backend (validar body do request) — sem duplicação.

import { z } from 'zod';

// ─── Enums ────────────────────────────────────────────────────────────────────

export const EventStatusSchema = z.enum([
  'draft',       // rascunho — organizador ainda configura
  'published',   // publicado — visível para compradores
  'on_sale',     // venda ativa — pode comprar ingressos
  'sold_out',    // esgotado
  'cancelled',   // cancelado — reembolsos disparados
  'completed',   // evento ocorreu — ingressos encerrados
]);

export type EventStatus = z.infer<typeof EventStatusSchema>;

export const SeatingTypeSchema = z.enum([
  'reserved',           // assento numerado
  'general_admission',  // área geral sem assento fixo
]);

export type SeatingType = z.infer<typeof SeatingTypeSchema>;

// ─── Venue ────────────────────────────────────────────────────────────────────

// Schema base — campos do Venue em si (sem as seções)
export const CreateVenueSchema = z.object({
  name: z.string().min(3).max(200),
  address: z.string().min(5).max(500),
  city: z.string().min(2).max(100),
  state: z.string().length(2),           // sigla do estado: SP, RJ, etc.
  zipCode: z.string().regex(/^\d{8}$/),  // apenas dígitos, sem hífen
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  capacity: z.number().int().positive(),
});

export type CreateVenueDto = z.infer<typeof CreateVenueSchema>;

// Input de seção — reserved requer rows/seatsPerRow; general_admission não tem assentos
export const CreateSectionInputSchema = z.object({
  name: z.string().min(1).max(100),
  seatingType: SeatingTypeSchema,
  // Para reserved: lista de linhas ["A","B","C"] e quantos assentos por linha
  // Para general_admission: esses campos podem ser omitidos
  rows: z.array(z.string().min(1).max(3)).optional(),
  seatsPerRow: z.number().int().positive().optional(),
}).refine(
  (data) => {
    if (data.seatingType === 'reserved') {
      return data.rows !== undefined && data.rows.length > 0 && data.seatsPerRow !== undefined;
    }
    return true;
  },
  { message: 'Seções reserved exigem rows[] e seatsPerRow', path: ['rows'] },
);

export type CreateSectionInput = z.infer<typeof CreateSectionInputSchema>;

// Schema do endpoint POST /venues — venue + seções em um request atômico
export const CreateVenueWithSectionsSchema = CreateVenueSchema.extend({
  sections: z.array(CreateSectionInputSchema).min(1).max(50),
});

export type CreateVenueWithSectionsDto = z.infer<typeof CreateVenueWithSectionsSchema>;

// ─── Category ─────────────────────────────────────────────────────────────────

export const CreateCategorySchema = z.object({
  name: z.string().min(2).max(100),
  slug: z.string().min(2).max(100).regex(/^[a-z0-9-]+$/),
  icon: z.string().max(50).optional(),
});

export type CreateCategoryDto = z.infer<typeof CreateCategorySchema>;

// ─── Event ────────────────────────────────────────────────────────────────────

export const CreateEventSchema = z.object({
  venueId: z.uuid(),
  categoryId: z.uuid(),
  title: z.string().min(5).max(200),
  description: z.string().max(10_000),
  startAt: z.coerce.date(),    // aceita string ISO 8601 e converte para Date
  endAt: z.coerce.date(),
  thumbnailUrl: z.url().optional(),
  maxTicketsPerOrder: z.number().int().min(1).max(10).default(4),
  ageRestriction: z.number().int().min(0).max(21).optional(),
}).refine(
  (data) => data.endAt > data.startAt,
  { message: 'endAt deve ser posterior a startAt', path: ['endAt'] },
);

export type CreateEventDto = z.infer<typeof CreateEventSchema>;

export const EventResponseSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  slug: z.string(),
  status: EventStatusSchema,
  startAt: z.coerce.date(),
  endAt: z.coerce.date(),
  venueName: z.string(),
  venueCity: z.string(),
  venueState: z.string(),
  thumbnailUrl: z.url().nullable(),
  minPrice: z.number().nullable(),
  availableTickets: z.number().int(),
  createdAt: z.coerce.date(),
});

export type EventResponse = z.infer<typeof EventResponseSchema>;

// ─── Ticket Batch ─────────────────────────────────────────────────────────────
//
// eventId NÃO faz parte do body: vem do path param /events/:eventId/ticket-batches.
// Colocar aqui geraria duplicação e risco de divergência (body.eventId ≠ url.eventId).

export const CreateTicketBatchSchema = z.object({
  name: z.string().min(2).max(100),   // ex: "Pista", "VIP", "Camarote"
  price: z.number().nonnegative().multipleOf(0.01),
  totalQuantity: z.number().int().positive(),
  saleStartAt: z.coerce.date(),
  saleEndAt: z.coerce.date(),
  // sectionId opcional — null = lote válido em todas as seções do venue
  sectionId: z.uuid().optional(),
  // isVisible controla se o lote aparece no mapa de assentos do comprador
  isVisible: z.boolean().default(true),
}).refine(
  (data) => data.saleEndAt > data.saleStartAt,
  { message: 'saleEndAt deve ser posterior a saleStartAt', path: ['saleEndAt'] },
);

export type CreateTicketBatchDto = z.infer<typeof CreateTicketBatchSchema>;

// Update aceita campos parciais — organizer pode alterar preço, visibilidade,
// ou estender o período de venda sem recriar o lote.
export const UpdateTicketBatchSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  price: z.number().nonnegative().multipleOf(0.01).optional(),
  // totalQuantity NÃO pode diminuir abaixo de soldCount + reservedCount
  // (validação em runtime no service, não dá para expressar em Zod)
  totalQuantity: z.number().int().positive().optional(),
  saleStartAt: z.coerce.date().optional(),
  saleEndAt: z.coerce.date().optional(),
  isVisible: z.boolean().optional(),
});

export type UpdateTicketBatchDto = z.infer<typeof UpdateTicketBatchSchema>;