// apps/search-service/src/modules/search/search.controller.ts
//
// Rotas públicas (sem guard) — busca é pública. Validação Zod cobre
// sanitização da query (OWASP A03).

import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import { SearchService } from './search.service.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';

const SearchQuerySchema = z.object({
  q: z.string().min(1).optional(),
  city: z.string().optional(),
  state: z.string().length(2).optional(),
  startAfter: z.coerce.date().optional(),
  startBefore: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

type SearchQuery = z.infer<typeof SearchQuerySchema>;

@Controller('search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  /**
   * GET /search/events?q=Bruno+Mars&city=São%20Paulo&page=1
   */
  @Get('events')
  search(
    @Query(new ZodValidationPipe(SearchQuerySchema)) query: SearchQuery,
  ): ReturnType<SearchService['searchEvents']> {
    return this.searchService.searchEvents({
      ...(query.q !== undefined ? { q: query.q } : {}),
      ...(query.city !== undefined ? { city: query.city } : {}),
      ...(query.state !== undefined ? { state: query.state } : {}),
      ...(query.startAfter !== undefined ? { startAfter: query.startAfter } : {}),
      ...(query.startBefore !== undefined
        ? { startBefore: query.startBefore }
        : {}),
      page: query.page,
      limit: query.limit,
    });
  }

  /**
   * GET /search/autocomplete?q=ro → { suggestions: ["Rock in Rio 2026", ...] }
   */
  @Get('autocomplete')
  async autocomplete(
    @Query('q') q: string,
  ): Promise<{ suggestions: string[] }> {
    if (!q || q.length < 2) return { suggestions: [] };
    const suggestions = await this.searchService.autocomplete(q);
    return { suggestions };
  }
}
