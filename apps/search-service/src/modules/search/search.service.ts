// apps/search-service/src/modules/search/search.service.ts
//
// Núcleo da busca. Monta uma query bool { must, filter }: `must` afeta o
// score (relevância), `filter` não (e é cacheável pelo ES).

import { Injectable } from '@nestjs/common';
import { ElasticsearchService } from '@nestjs/elasticsearch';
import type { estypes } from '@elastic/elasticsearch';
import { EVENT_INDEX } from './event-index.js';

export interface SearchEventsParams {
  q?: string;
  city?: string;
  state?: string;
  startAfter?: Date;
  startBefore?: Date;
  page?: number;
  limit?: number;
}

export interface EventDocument {
  id: string;
  organizerId: string;
  title: string;
  slug: string;
  status: string;
  startAt: string;
  endAt: string;
  venueCity: string;
  venueState: string;
  thumbnailUrl: string | null;
}

@Injectable()
export class SearchService {
  constructor(private readonly es: ElasticsearchService) {}

  async searchEvents(params: SearchEventsParams): Promise<{
    hits: EventDocument[];
    total: number;
    page: number;
    limit: number;
  }> {
    const page = params.page ?? 1;
    const limit = Math.min(params.limit ?? 20, 100);
    const from = (page - 1) * limit;

    const mustClauses: estypes.QueryDslQueryContainer[] = [];
    const filterClauses: estypes.QueryDslQueryContainer[] = [];

    // ─── Busca textual (multi_match com pesos) ──────────────────────────────
    if (params.q) {
      mustClauses.push({
        multi_match: {
          query: params.q,
          fields: [
            'title^3', // título com peso 3x
            'title.autocomplete^2', // autocomplete com peso 2x
            'slug',
          ],
          fuzziness: 'AUTO',
          prefix_length: 2, // primeiras 2 letras devem estar corretas
          operator: 'and', // todos os termos precisam aparecer
        },
      });
    }

    // ─── Filtros exatos (não afetam score; cacheados pelo ES) ──────────────
    if (params.city) filterClauses.push({ term: { venueCity: params.city } });
    if (params.state) filterClauses.push({ term: { venueState: params.state } });

    // Apenas eventos em venda
    filterClauses.push({ term: { status: 'on_sale' } });

    // Apenas eventos futuros (sempre — exclui eventos já encerrados).
    // Objeto concreto (não Record) p/ permitir acesso por propriedade sob
    // noPropertyAccessFromIndexSignature.
    const dateRange: { gte: string; lte?: string } = {
      gte: new Date().toISOString(),
    };
    if (params.startAfter) dateRange.gte = params.startAfter.toISOString();
    if (params.startBefore) dateRange.lte = params.startBefore.toISOString();
    filterClauses.push({ range: { startAt: dateRange } });

    // Com q: ordena por relevância depois data. Sem q: só cronológico.
    // ES v9 tipa sort estritamente — _score exige a forma objeto (ScoreSort),
    // não o atalho string.
    const sort: estypes.Sort = params.q
      ? [{ _score: { order: 'desc' } }, { startAt: { order: 'asc' } }]
      : [{ startAt: { order: 'asc' } }];

    // ─── Executar busca ─────────────────────────────────────────────────────
    const response = (await this.es.search<EventDocument>({
      index: EVENT_INDEX,
      from,
      size: limit,
      query: { bool: { must: mustClauses, filter: filterClauses } },
      sort,
    })) as estypes.SearchResponse<EventDocument>;

    const total =
      typeof response.hits.total === 'number'
        ? response.hits.total
        : response.hits.total?.value ?? 0;

    return {
      hits: response.hits.hits.map(
        (h: estypes.SearchHit<EventDocument>) => h._source as EventDocument,
      ),
      total,
      page,
      limit,
    };
  }

  /**
   * Sugestões para a barra de busca (digite "ro" → "Rock in Rio").
   * Usa o subcampo title.autocomplete (edge_ngram).
   */
  async autocomplete(q: string): Promise<string[]> {
    const response = (await this.es.search<EventDocument>({
      index: EVENT_INDEX,
      size: 5,
      query: {
        match: {
          'title.autocomplete': { query: q, operator: 'and' },
        },
      },
      _source: ['title'],
    })) as estypes.SearchResponse<EventDocument>;

    return response.hits.hits
      .map((h: estypes.SearchHit<EventDocument>) => h._source?.title ?? '')
      .filter(Boolean);
  }
}
