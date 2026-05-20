// apps/web/src/lib/api/events.ts
//
// Funções de API de eventos — servem Server e Client Components (mesmo código).

import { z } from 'zod';
import { EventResponseSchema, EventPublicResponseSchema } from '@showpass/types';
import { apiRequest } from '../api-client';

const EventListResponseSchema = z.object({
  items: z.array(EventResponseSchema),
  total: z.number(),
  page: z.number(),
  limit: z.number(),
});

const SearchResponseSchema = z.object({
  hits: z.array(EventResponseSchema),
  total: z.number(),
  page: z.number(),
  limit: z.number(),
});

// GET /events/:slug/public devolve o DETALHE completo (venue.sections.seats,
// ticketBatches, organizer). Validar com EventPublicResponseSchema — o schema
// resumido faria o Zod dropar esses campos (e o SeatMap do cap-11 quebraria).
export function getEventBySlug(
  slug: string,
): Promise<z.infer<typeof EventPublicResponseSchema>> {
  return apiRequest(`/events/${slug}/public`, EventPublicResponseSchema, {
    skipAuth: true,
  });
}

export function searchEvents(params: {
  q?: string;
  city?: string;
  state?: string;
  category?: string;
  page?: number;
}): Promise<z.infer<typeof SearchResponseSchema>> {
  const query = new URLSearchParams();
  if (params.q) query.set('q', params.q);
  if (params.city) query.set('city', params.city);
  if (params.state) query.set('state', params.state);
  if (params.category) query.set('category', params.category);
  query.set('page', String(params.page ?? 1));

  return apiRequest(
    `/search/events?${query.toString()}`,
    SearchResponseSchema,
    { skipAuth: true },
  );
}

export function getMyEvents(
  page = 1,
): Promise<z.infer<typeof EventListResponseSchema>> {
  return apiRequest(`/events?page=${String(page)}`, EventListResponseSchema);
}
