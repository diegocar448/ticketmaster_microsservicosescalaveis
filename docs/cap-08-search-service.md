# Capítulo 8 — Search Service

> **Objetivo:** Construir busca full-text de eventos com Elasticsearch 9, sincronização via CDC (Debezium + Kafka), e suporte a filtros geográficos para "eventos perto de mim".

## O que você vai aprender

- Por que Elasticsearch e não PostgreSQL LIKE para busca em grande escala
- Tokenização, stemming e fuzziness — encontra resultados mesmo com erros de digitação
- Similaridade: buscar "casa" retorna "casinha", "casarão", "casebre"
- CDC (Change Data Capture): Debezium captura o WAL do Postgres e publica no Kafka
- Index mapping com analisadores de texto em português
- Geo distance filter — eventos em raio de X km

---

## Por que não usar SQL LIKE?

```sql
-- ❌ O jeito ERRADO que NÃO funciona em grande escala:
SELECT * FROM events
WHERE name LIKE '%Bruno Mars%'
  AND start_date >= '2026-04-01'
  AND end_date   <= '2026-04-30'
```

**Problemas desta query:**

| Problema | Impacto |
|---|---|
| `LIKE '%palavra%'` não usa índice B-tree | Full table scan em 10M de eventos = lento |
| Sem tolerância a typos | "Bruno Marz" não encontra "Bruno Mars" |
| Sem stemming | "shows" não encontra "show" |
| Sem relevância | Não sabe que "Bruno Mars" no título é mais relevante que na descrição |
| Cache ineficaz | Cada variação de query é uma chave diferente no cache |

**O jeito certo: Elasticsearch como motor de busca dedicado**

```
PostgreSQL (fonte de verdade)
    │
    │ CDC via WAL (Write-Ahead Logging)
    ▼
Debezium → Kafka → Search Service
                       │
                       ▼
                Elasticsearch (índice otimizado para busca)
                  • Inverted index (não B-tree)
                  • Analisadores de linguagem
                  • Scoring de relevância (BM25)
                  • Fuzziness automático
                  • Geo proximity
```

---

## Tokenização e Stemming — Como o Elasticsearch "Entende" Texto

```
Texto original: "Bruno Mars Live em São Paulo 2026"

Após tokenização + lowercase + asciifolding:
  ["bruno", "mars", "live", "em", "sao", "paulo", "2026"]

Após remoção de stopwords (palavras sem valor de busca):
  ["bruno", "mars", "live", "sao", "paulo", "2026"]

Após stemming (redução à raiz morfológica):
  Texto em inglês: "shows" → "show", "singing" → "sing"
  Texto em PT-BR:  "cantores" → "cantor", "cantando" → "cantar"
                   "casinha"  → "cas",    "casarão"  → "cas"
                   "casebre"  → "cas"

Resultado: buscar "casa" encontra "casinha", "casarão", "casebre"
           porque todos compartilham a mesma raiz "cas"
```

```
Fuzziness (tolerância a typos):
  Busca: "Bruno Marz"  → encontra "Bruno Mars"   (1 caractere diferente)
  Busca: "Methalica"   → encontra "Metallica"    (2 caracteres diferentes)
  Busca: "Whinderson"  → encontra "Whindersson"  (1 caractere diferente)

Algoritmo: Levenshtein Distance (número de edições para transformar uma palavra na outra)
  fuzziness: AUTO → distância 0 para palavras ≤2 chars, 1 para ≤5, 2 para >5
```

---

## Por que CDC com Debezium?

```
SEM CDC (polling):
  Search Service → SELECT * FROM events WHERE updated_at > ? (a cada 30s)
  Problema: delay de até 30s, carga no banco, acoplamento direto ao DB

COM CDC (Debezium):
  PostgreSQL WAL → Debezium → Kafka → Search Service
  Vantagens:
  - Captura TODA mudança (INSERT, UPDATE, DELETE) em tempo real
  - Sem carga adicional na aplicação
  - Desacoplado: search-service não precisa conhecer o schema do event-service
  - Replay: se o search-service cair, ele processa as mudanças ao voltar
```

### O que é o WAL (Write-Ahead Logging)?

```
PostgreSQL grava TODA mudança no WAL antes de aplicar no banco:

  WAL entry: "foi criado o evento 10579"
  WAL entry: "o nome do evento 211 mudou"
  WAL entry: "o evento 4456 foi removido"
  WAL entry: "o evento 554 foi atualizado"

Debezium lê o WAL como se fosse um "replica" do PostgreSQL.
Cada entrada vira uma mensagem no Kafka:

  cdc.public.events → { op: 'c', after: { id: 10579, title: '...', ... } }
  cdc.public.events → { op: 'u', before: { id: 211, title: 'Antigo' }, after: { id: 211, title: 'Novo' } }
  cdc.public.events → { op: 'd', before: { id: 4456, title: '...' } }

  op: 'c' = create, 'u' = update, 'r' = read/snapshot, 'd' = delete

O Search Service consome essas mensagens e atualiza o índice do Elasticsearch
sem nunca tocar diretamente no banco de dados do event-service.
```

---

## Passo 8.1 — Configurar Debezium (docker-compose)

```yaml
# Adicionar ao docker-compose.yml

debezium:
  image: debezium/connect:3.0
  restart: unless-stopped
  environment:
    BOOTSTRAP_SERVERS: kafka:9092
    GROUP_ID: debezium-connect
    CONFIG_STORAGE_TOPIC: debezium_configs
    OFFSET_STORAGE_TOPIC: debezium_offsets
    STATUS_STORAGE_TOPIC: debezium_statuses
  ports:
    - "8083:8083"
  networks:
    - data
  depends_on:
    kafka:
      condition: service_healthy
    postgres:
      condition: service_healthy
```

```bash
# Após subir o Debezium, registrar o conector PostgreSQL
# Este conector monitora as tabelas de eventos e publica no Kafka

curl -X POST http://localhost:8083/connectors \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "showpass-events-connector",
    "config": {
      "connector.class": "io.debezium.connector.postgresql.PostgresConnector",
      "database.hostname": "postgres",
      "database.port": "5432",
      "database.user": "event_svc",
      "database.password": "event_svc_dev",
      "database.dbname": "showpass_events",
      "table.include.list": "public.events,public.ticket_batches",
      "topic.prefix": "cdc",
      "plugin.name": "pgoutput",
      "publication.name": "showpass_publication",
      "slot.name": "showpass_slot",
      "transforms": "unwrap",
      "transforms.unwrap.type": "io.debezium.transforms.ExtractNewRecordState",
      "transforms.unwrap.drop.tombstones": "false",
      "transforms.unwrap.delete.handling.mode": "rewrite"
    }
  }'

# Tópicos criados automaticamente:
# cdc.public.events          ← cada INSERT/UPDATE/DELETE em events
# cdc.public.ticket_batches  ← mudanças nos lotes de ingressos
```

---

## Passo 8.2 — Elasticsearch Index Mapping

```typescript
// apps/search-service/src/modules/search/event-index.ts
//
// Define o mapping do índice de eventos no Elasticsearch.
// O mapping controla como cada campo é analisado e indexado.

export const EVENT_INDEX = 'events';

export const EVENT_INDEX_MAPPING = {
  settings: {
    analysis: {
      analyzer: {
        // Analisador customizado para português brasileiro
        // Reconhece acentos, stemming, stopwords do PT-BR
        portuguese_analyzer: {
          type: 'custom',
          tokenizer: 'standard',
          filter: [
            'lowercase',
            'asciifolding',        // remove acentos: "música" → "musica"
            'portuguese_stop',     // remove stopwords: "de", "da", "com"
            'portuguese_stemmer',  // reduz à raiz: "cantores" → "cantor"
          ],
        },
        // Analisador para autocomplete (prefixo)
        autocomplete_analyzer: {
          type: 'custom',
          tokenizer: 'standard',
          filter: ['lowercase', 'asciifolding', 'edge_ngram_filter'],
        },
      },
      filter: {
        portuguese_stop: {
          type: 'stop',
          stopwords: '_portuguese_',
        },
        portuguese_stemmer: {
          type: 'stemmer',
          language: 'portuguese',
        },
        edge_ngram_filter: {
          type: 'edge_ngram',
          min_gram: 2,
          max_gram: 20,
        },
      },
    },
  },
  mappings: {
    properties: {
      id: { type: 'keyword' },
      title: {
        type: 'text',
        analyzer: 'portuguese_analyzer',
        // Campo adicional para autocomplete (sem stemming)
        fields: {
          autocomplete: {
            type: 'text',
            analyzer: 'autocomplete_analyzer',
            search_analyzer: 'standard',
          },
          // Campo keyword para sorting e filtering exato
          keyword: { type: 'keyword' },
        },
      },
      description: {
        type: 'text',
        analyzer: 'portuguese_analyzer',
        // Não armazenar (economia de storage) — apenas para busca
        store: false,
      },
      categorySlug: { type: 'keyword' },
      categoryName: { type: 'text', analyzer: 'portuguese_analyzer' },
      organizerName: { type: 'keyword' },
      venueName: { type: 'text', analyzer: 'portuguese_analyzer' },
      venueCity: { type: 'keyword' },
      venueState: { type: 'keyword' },
      status: { type: 'keyword' },
      startAt: { type: 'date' },
      endAt: { type: 'date' },
      minPrice: { type: 'float' },
      maxPrice: { type: 'float' },
      availableTickets: { type: 'integer' },
      thumbnailUrl: { type: 'keyword', index: false },  // não indexar URLs

      // Campo geo_point para buscas por proximidade
      // Formato: { lat: -23.5, lon: -46.6 }
      location: { type: 'geo_point' },
    },
  },
};
```

---

## Passo 8.3 — Search Service

```typescript
// apps/search-service/src/modules/search/search.service.ts

import { Injectable, Logger } from '@nestjs/common';
import { ElasticsearchService } from '@nestjs/elasticsearch';
import type { SearchResponse } from '@elastic/elasticsearch/lib/api/types';
import { EVENT_INDEX } from './event-index';

export interface SearchEventsParams {
  q?: string;          // texto livre
  city?: string;
  state?: string;
  categorySlug?: string;
  minPrice?: number;
  maxPrice?: number;
  startAfter?: Date;
  startBefore?: Date;
  lat?: number;        // para busca geográfica
  lon?: number;
  radiusKm?: number;
  page?: number;
  limit?: number;
}

export interface EventDocument {
  id: string;
  title: string;
  categorySlug: string;
  venueName: string;
  venueCity: string;
  venueState: string;
  startAt: string;
  minPrice: number;
  availableTickets: number;
  thumbnailUrl: string | null;
}

@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);

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

    // ─── Construir a query ────────────────────────────────────────────────────
    const query: Record<string, unknown> = {
      bool: {
        must: [],
        filter: [],
      },
    };

    const mustClauses: unknown[] = [];
    const filterClauses: unknown[] = [];

    // ─── Busca textual com multi_match ────────────────────────────────────────
    if (params.q) {
      mustClauses.push({
        multi_match: {
          query: params.q,
          fields: [
            'title^3',               // título tem peso 3x maior
            'title.autocomplete^2',  // autocomplete com peso 2x
            'description',
            'venueName',
            'organizerName',
          ],
          // fuzziness: AUTO = 1 erro p/ 3-5 chars, 2 erros p/ 6+ chars
          // "Bruno Marz" encontra "Bruno Mars"
          fuzziness: 'AUTO',
          prefix_length: 2,          // primeiras 2 letras devem estar corretas
          operator: 'and',           // todos os termos devem existir
        },
      });
    }

    // ─── Filtros exatos ────────────────────────────────────────────────────────
    if (params.city) {
      filterClauses.push({ term: { venueCity: params.city } });
    }

    if (params.state) {
      filterClauses.push({ term: { venueState: params.state } });
    }

    if (params.categorySlug) {
      filterClauses.push({ term: { categorySlug: params.categorySlug } });
    }

    // Apenas eventos disponíveis para venda
    filterClauses.push({ term: { status: 'on_sale' } });

    // Apenas eventos futuros
    filterClauses.push({
      range: { startAt: { gte: new Date().toISOString() } },
    });

    // ─── Filtro de preço ──────────────────────────────────────────────────────
    if (params.minPrice !== undefined || params.maxPrice !== undefined) {
      filterClauses.push({
        range: {
          minPrice: {
            ...(params.minPrice !== undefined ? { gte: params.minPrice } : {}),
            ...(params.maxPrice !== undefined ? { lte: params.maxPrice } : {}),
          },
        },
      });
    }

    // ─── Filtro geográfico ────────────────────────────────────────────────────
    if (params.lat !== undefined && params.lon !== undefined) {
      const radius = params.radiusKm ?? 50;
      filterClauses.push({
        geo_distance: {
          distance: `${radius}km`,
          location: { lat: params.lat, lon: params.lon },
        },
      });
    }

    // Filtro de data
    if (params.startAfter || params.startBefore) {
      filterClauses.push({
        range: {
          startAt: {
            ...(params.startAfter ? { gte: params.startAfter.toISOString() } : {}),
            ...(params.startBefore ? { lte: params.startBefore.toISOString() } : {}),
          },
        },
      });
    }

    (query.bool as Record<string, unknown>).must = mustClauses;
    (query.bool as Record<string, unknown>).filter = filterClauses;

    // ─── Executar busca ───────────────────────────────────────────────────────
    const response = await this.es.search<EventDocument>({
      index: EVENT_INDEX,
      from,
      size: limit,
      query,
      sort: params.q
        ? [{ _score: 'desc' }, { startAt: 'asc' }]  // relevância primeiro
        : [{ startAt: 'asc' }],                       // sem texto: ordem cronológica
      _source: [
        'id', 'title', 'categorySlug', 'venueName',
        'venueCity', 'venueState', 'startAt', 'minPrice',
        'availableTickets', 'thumbnailUrl',
      ],
    });

    const hits = (response as SearchResponse<EventDocument>).hits;
    const total = typeof hits.total === 'number' ? hits.total : hits.total?.value ?? 0;

    return {
      hits: hits.hits.map((h) => h._source as EventDocument),
      total,
      page,
      limit,
    };
  }

  async autocomplete(q: string): Promise<string[]> {
    const response = await this.es.search<EventDocument>({
      index: EVENT_INDEX,
      size: 5,
      query: {
        match: {
          'title.autocomplete': {
            query: q,
            operator: 'and',
          },
        },
      },
      _source: ['title'],
    });

    return (response as SearchResponse<EventDocument>).hits.hits
      .map((h) => h._source?.title ?? '')
      .filter(Boolean);
  }
}
```

---

## Passo 8.4 — Kafka Consumer (CDC Indexer)

```typescript
// apps/search-service/src/modules/indexer/event-indexer.service.ts
//
// Consome eventos CDC do Debezium e indexa/remove do Elasticsearch.
// O padrão @EventPattern do NestJS registra o consumer automaticamente.

import { Controller, Logger } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { ElasticsearchService } from '@nestjs/elasticsearch';
import { KAFKA_TOPICS } from '@showpass/types';
import { EVENT_INDEX } from '../search/event-index';

interface CdcEventPayload {
  op: 'c' | 'u' | 'd' | 'r';  // create, update, delete, read (snapshot)
  after: Record<string, unknown> | null;
  before: Record<string, unknown> | null;
}

@Controller()
export class EventIndexerService {
  private readonly logger = new Logger(EventIndexerService.name);

  constructor(private readonly es: ElasticsearchService) {}

  /**
   * Processa eventos CDC do Debezium (tabela events).
   * Chamado automaticamente pelo @EventPattern quando mensagem chega no tópico.
   */
  @EventPattern('cdc.public.events')
  async handleEventCdc(@Payload() payload: CdcEventPayload): Promise<void> {
    try {
      switch (payload.op) {
        case 'c':  // INSERT
        case 'u':  // UPDATE
        case 'r':  // Snapshot inicial (Debezium lê tabela existente ao conectar)
          if (payload.after) {
            await this.indexEvent(payload.after);
          }
          break;

        case 'd':  // DELETE
          if (payload.before) {
            await this.removeEvent(payload.before.id as string);
          }
          break;
      }
    } catch (error) {
      this.logger.error('Erro ao indexar evento CDC', {
        error: (error as Error).message,
        op: payload.op,
      });
      // Re-throw para o Kafka recolocar na fila (retry automático)
      throw error;
    }
  }

  /**
   * Escuta eventos de domínio publicados pelo event-service.
   * Útil para mudanças de status que o CDC pode demorar a propagar.
   */
  @EventPattern(KAFKA_TOPICS.EVENT_PUBLISHED)
  async handleEventPublished(@Payload() payload: { eventId: string }): Promise<void> {
    // Buscar dados atualizados do event-service e re-indexar
    await this.reindexFromSource(payload.eventId);
  }

  @EventPattern(KAFKA_TOPICS.EVENT_CANCELLED)
  async handleEventCancelled(@Payload() payload: { eventId: string }): Promise<void> {
    // Remover do índice de busca — evento cancelado não aparece mais
    await this.removeEvent(payload.eventId);
  }

  private async indexEvent(eventData: Record<string, unknown>): Promise<void> {
    // Apenas indexar eventos publicados ou em venda
    const indexableStatuses = ['published', 'on_sale', 'sold_out'];
    if (!indexableStatuses.includes(eventData.status as string)) {
      // Se o evento estava indexado mas mudou para draft/cancelled, remover
      await this.removeEvent(eventData.id as string);
      return;
    }

    const document = this.transformToDocument(eventData);

    await this.es.index({
      index: EVENT_INDEX,
      id: document.id,
      document,
    });

    this.logger.debug(`Evento indexado: ${document.id}`);
  }

  private async removeEvent(eventId: string): Promise<void> {
    try {
      await this.es.delete({ index: EVENT_INDEX, id: eventId });
      this.logger.debug(`Evento removido do índice: ${eventId}`);
    } catch (error) {
      // Ignorar 404 — evento pode não estar no índice (idempotente)
      if ((error as { statusCode?: number }).statusCode !== 404) {
        throw error;
      }
    }
  }

  private transformToDocument(data: Record<string, unknown>): Record<string, unknown> {
    return {
      id: data.id,
      title: data.title,
      description: data.description,
      status: data.status,
      categorySlug: data.category_slug,
      categoryName: data.category_name,
      organizerName: data.organizer_name,
      venueName: data.venue_name,
      venueCity: data.venue_city,
      venueState: data.venue_state,
      startAt: data.start_at,
      endAt: data.end_at,
      minPrice: data.min_price,
      availableTickets: data.available_tickets,
      thumbnailUrl: data.thumbnail_url ?? null,
      // geo_point: Elasticsearch espera { lat, lon }
      location: data.latitude && data.longitude
        ? { lat: Number(data.latitude), lon: Number(data.longitude) }
        : null,
    };
  }

  private async reindexFromSource(eventId: string): Promise<void> {
    const url = `${process.env.EVENT_SERVICE_URL}/events/${eventId}`;
    const res = await fetch(url);
    if (!res.ok) return;
    const data = await res.json() as Record<string, unknown>;
    await this.indexEvent(data);
  }
}
```

---

## Passo 8.5 — Search Controller

```typescript
// apps/search-service/src/modules/search/search.controller.ts

import { Controller, Get, Query } from '@nestjs/common';
import { SearchService } from './search.service';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';

const SearchQuerySchema = z.object({
  q: z.string().optional(),
  city: z.string().optional(),
  state: z.string().length(2).optional(),
  category: z.string().optional(),
  minPrice: z.coerce.number().nonnegative().optional(),
  maxPrice: z.coerce.number().nonnegative().optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lon: z.coerce.number().min(-180).max(180).optional(),
  radius: z.coerce.number().positive().max(500).default(50),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

type SearchQuery = z.infer<typeof SearchQuerySchema>;

@Controller('search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  /**
   * Busca de eventos — rota pública.
   * Ex: GET /search/events?q=Bruno+Mars&city=São Paulo&page=1
   */
  @Get('events')
  search(
    @Query(new ZodValidationPipe(SearchQuerySchema)) query: SearchQuery,
  ) {
    return this.searchService.searchEvents({
      q: query.q,
      city: query.city,
      state: query.state,
      categorySlug: query.category,
      minPrice: query.minPrice,
      maxPrice: query.maxPrice,
      lat: query.lat,
      lon: query.lon,
      radiusKm: query.radius,
      page: query.page,
      limit: query.limit,
    });
  }

  /**
   * Autocomplete para a barra de busca.
   * Ex: GET /search/autocomplete?q=Brun
   * Retorna: ["Bruno Mars", "Bruno e Marrone", ...]
   */
  @Get('autocomplete')
  autocomplete(@Query('q') q: string) {
    if (!q || q.length < 2) return { suggestions: [] };
    return this.searchService.autocomplete(q).then((s) => ({ suggestions: s }));
  }
}
```

---

## Testando na prática

O search-service indexa dados via Kafka (CDC com Debezium). Você pode testar a busca diretamente no Elasticsearch **e** pelo search-service HTTP.

### O que precisa estar rodando

```bash
# Terminal 1 — infraestrutura completa (inclui Elasticsearch + Debezium)
docker compose up -d

# Aguardar Elasticsearch inicializar (~30s)
curl -s http://localhost:9200/_cluster/health | jq .status
# Aguardar retornar "yellow" ou "green"

# Terminal 2 — auth-service
pnpm --filter auth-service run dev

# Terminal 3 — event-service
pnpm --filter event-service run dev

# Terminal 4 — search-service
pnpm --filter search-service run dev        # porta 3005
```

O Debezium começa a capturar mudanças do PostgreSQL automaticamente após subir.

### Passo a passo

**1. Verificar que o Elasticsearch está operacional**

```bash
curl -s http://localhost:9200 | jq '{name, version: .version.number, status: .tagline}'
```

**2. Verificar que o índice `events` foi criado**

```bash
curl -s http://localhost:9200/events | jq '.events.mappings.properties | keys'
```

Você verá os campos: `title`, `description`, `venueCity`, `location`, `startsAt`, etc.

**3. Busca por texto livre**

```bash
curl -s "http://localhost:3005/search?q=rock" | jq .
```

Resposta esperada:

```json
{
  "total": 1,
  "hits": [
    {
      "id": "018e9999-...",
      "title": "Rock in Rio 2025",
      "venueCity": "Rio de Janeiro",
      "startsAt": "2025-09-26T18:00:00Z",
      "status": "on_sale"
    }
  ]
}
```

**4. Busca com typo (fuzziness)**

```bash
# "rok" → encontra "Rock" (1 caractere diferente)
curl -s "http://localhost:3005/search?q=rok+in+rio" | jq '.total'
```

Resposta esperada: `1` — o analisador português com `fuzziness: AUTO` tolera erros de digitação.

**5. Busca por cidade**

```bash
curl -s "http://localhost:3005/search?q=rock&city=Rio+de+Janeiro" | jq '.hits[0].venueCity'
```

**6. Busca geográfica por proximidade**

```bash
# Eventos em até 50km do Cristo Redentor (lat -22.951916, lon -43.210487)
curl -s "http://localhost:3005/search?q=rock&lat=-22.951916&lon=-43.210487&radius=50km" | jq .
```

**7. Autocomplete (enquanto digita)**

```bash
curl -s "http://localhost:3005/search/autocomplete?q=ro" | jq .
```

Resposta esperada: sugestões como `["Rock in Rio 2025", "Rock Nacional..."]`.

**8. Verificar CDC em tempo real**

Crie um novo evento via event-service e veja aparecer na busca em ~2 segundos:

```bash
# Criar evento
curl -s -X POST http://localhost:3003/events \
  -H "Authorization: Bearer $ORGANIZER_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"title\":\"Lollapalooza Brasil 2025\",\"slug\":\"lolla-2025\",\"description\":\"Festival\",\"categoryId\":\"$CATEGORY_ID\",\"venueId\":\"$VENUE_ID\",\"startsAt\":\"2025-03-28T18:00:00Z\",\"endsAt\":\"2025-03-30T23:00:00Z\",\"currency\":\"BRL\",\"maxTicketsPerOrder\":4}" | jq .id

sleep 3

# Buscar o novo evento
curl -s "http://localhost:3005/search?q=lollapalooza" | jq '.total'
```

Resposta esperada: `1` — o Debezium capturou o INSERT no PostgreSQL, o Kafka consumer indexou no Elasticsearch.

**9. Verificar conectores Debezium**

```bash
curl -s http://localhost:8083/connectors | jq .
curl -s http://localhost:8083/connectors/events-connector/status | jq .connector.state
```

Estado esperado: `"RUNNING"`.

---

## Recapitulando

1. **CDC com Debezium** — captura mudanças do PostgreSQL em tempo real sem polling; busca sempre atualizada
2. **Index mapping customizado** — analisador português com stemming e remoção de acentos; "musica" encontra "música"
3. **multi_match com fuzziness** — tolerante a erros de digitação; `AUTO` calibra o número de erros aceitos
4. **geo_distance filter** — eventos próximos ao usuário com raio configurável
5. **Autocomplete com edge_ngram** — sugestões enquanto o usuário digita
6. **Kafka consumer idempotente** — se o evento for reprocessado, `es.index()` com mesmo ID apenas atualiza

---

## Próximo capítulo

[Capítulo 9 → Worker Service](cap-09-worker-service.md)
