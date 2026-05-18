# Capítulo 8 — Search Service

> **Objetivo:** Construir busca full-text de eventos com Elasticsearch 9, sincronização via **domain events Kafka** (mesmo padrão dos demais bounded contexts), e fundamentos para evoluir para CDC quando o volume justificar.

## O que você vai aprender

- Por que Elasticsearch e não PostgreSQL `LIKE` para busca em grande escala
- Tokenização, stemming e fuzziness — encontra resultados mesmo com erros de digitação
- Similaridade: buscar "casa" retorna "casinha", "casarão", "casebre"
- Index mapping com analisadores de texto em português
- Indexação assíncrona via Kafka (`events.event-published` / `events.event-updated` / `events.event-cancelled`)
- Pagination, autocomplete (`edge_ngram`) e sort por relevância vs cronologia
- Quando trocar Kafka domain events por CDC com Debezium (Outbox pattern — cap-18)

---

## Por que não usar SQL `LIKE`?

```sql
-- ❌ O jeito ERRADO que NÃO funciona em grande escala:
SELECT * FROM events
WHERE title ILIKE '%Bruno Mars%'
  AND start_at >= '2026-04-01'
  AND start_at <= '2026-04-30';
```

| Problema | Impacto |
|---|---|
| `ILIKE '%palavra%'` não usa índice B-tree | Full table scan em 10M de eventos = lento |
| Sem tolerância a typos | "Bruno Marz" não encontra "Bruno Mars" |
| Sem stemming | "shows" não encontra "show", "música" ≠ "musica" |
| Sem relevância | Não sabe que "Bruno Mars" no título pesa mais que na descrição |
| Cache ineficaz | Cada variação de query é uma chave diferente |

**O jeito certo: Elasticsearch como motor de busca dedicado**

```
event-service (PostgreSQL)
       │ emite ao publicar/atualizar/cancelar
       ▼
Kafka topics:
  events.event-published
  events.event-updated
  events.event-cancelled
       │ consumer @EventPattern
       ▼
search-service ──► Elasticsearch
                   • Inverted index (não B-tree)
                   • Analisadores de linguagem (português)
                   • Scoring de relevância (BM25)
                   • Fuzziness automático
                   • Autocomplete via edge_ngram
```

---

## Por que **domain events** em vez de CDC com Debezium?

> **Decisão consciente para o tutorial.** A versão didática deste capítulo usa os
> mesmos `events.event-*` que já alimentam a réplica local em booking-service
> (cap-06, Passo 6.11). Em produção real com volume muito alto, a evolução
> natural é CDC com Debezium + **Outbox pattern**. Isso é tratado no cap-18
> (Padrões Avançados) — aqui mantemos a coerência arquitetural com o resto do
> sistema e evitamos uma dependência (Debezium) que apareceria em um único
> lugar.

| Critério | Domain events Kafka | CDC com Debezium |
|---|---|---|
| Acoplamento | Baixo — schema do evento é contrato explícito | Acoplado ao schema da tabela |
| Denormalização (categoria, venue) | Trivial: emitter já faz JOIN | Exige Outbox pattern (tabela separada com snapshot) |
| Latência | ~50–200ms (Kafka in-memory) | ~10–50ms (lê WAL direto) |
| Stack para entender | NestJS + Kafka | NestJS + Kafka + Debezium + Connect + plugin pgoutput |
| Captura DELETE silencioso | Não — depende do emitter chamar | Sim — qualquer DELETE no banco é capturado |

**Quando trocar por CDC:** acima de ~10k eventos publicados/min, ou quando
auditoria exigir capturar mudanças que não passam por código (manuais via SQL,
migrations etc). Para o tutorial, domain events resolvem o problema sem
introduzir complexidade fora do tópico.

---

## Tokenização e Stemming — Como o Elasticsearch "entende" texto

```
Texto original: "Bruno Mars Live em São Paulo 2026"

Após tokenização + lowercase + asciifolding:
  ["bruno", "mars", "live", "em", "sao", "paulo", "2026"]

Após remoção de stopwords ("em", "de", "da", "com" etc):
  ["bruno", "mars", "live", "sao", "paulo", "2026"]

Após stemming português (redução à raiz morfológica):
  "cantores"  → "cantor"
  "cantando"  → "cantar"
  "casinha"   → "cas"
  "casarão"   → "cas"
  "casebre"   → "cas"

Resultado: buscar "casa" encontra "casinha", "casarão", "casebre"
```

```
Fuzziness (tolerância a typos — Levenshtein Distance):
  "Bruno Marz"  → encontra "Bruno Mars"   (1 edição)
  "Methalica"   → encontra "Metallica"    (2 edições)
  "Whinderson"  → encontra "Whindersson"  (1 edição)

  fuzziness: AUTO →
    distância 0 para palavras ≤ 2 chars
    distância 1 para 3–5 chars
    distância 2 para 6+ chars
```

---

## Passo 8.1 — Schema do índice (Elasticsearch mapping)

O mapping define **como cada campo é analisado**. Campos `text` passam por
analyzer; campos `keyword` são indexados raw (filtros exatos, agregações).

```typescript
// apps/search-service/src/modules/search/event-index.ts
//
// Mapping do índice "events".
// Apenas campos QUE CHEGAM no payload do EventReplicatedEvent:
//   id, organizerId, title, slug, status, startAt, endAt,
//   venueCity, venueState, thumbnailUrl
//
// categoria/organizerName/venueName não estão no payload — para indexá-los,
// o event-service precisa aumentar o EventReplicatedEvent (futuro) ou criar
// uma projection table com snapshot denormalizado (cap-18 Outbox).

export const EVENT_INDEX = 'events';

export const EVENT_INDEX_MAPPING = {
  settings: {
    analysis: {
      analyzer: {
        portuguese_analyzer: {
          type: 'custom',
          tokenizer: 'standard',
          filter: [
            'lowercase',
            'asciifolding',        // remove acentos: "música" → "musica"
            'portuguese_stop',     // remove stopwords PT-BR
            'portuguese_stemmer',  // reduz à raiz: "cantores" → "cantor"
          ],
        },
        autocomplete_analyzer: {
          type: 'custom',
          tokenizer: 'standard',
          filter: ['lowercase', 'asciifolding', 'edge_ngram_filter'],
        },
      },
      filter: {
        portuguese_stop:    { type: 'stop',      stopwords: '_portuguese_' },
        portuguese_stemmer: { type: 'stemmer',   language: 'portuguese' },
        edge_ngram_filter:  { type: 'edge_ngram', min_gram: 2, max_gram: 20 },
      },
    },
  },
  mappings: {
    properties: {
      id:          { type: 'keyword' },
      organizerId: { type: 'keyword' },
      title: {
        type: 'text',
        analyzer: 'portuguese_analyzer',
        fields: {
          // Subcampo para autocomplete (sem stemming)
          autocomplete: {
            type: 'text',
            analyzer: 'autocomplete_analyzer',
            search_analyzer: 'standard',
          },
          // Subcampo keyword para sort/aggregation exata
          keyword: { type: 'keyword' },
        },
      },
      slug:         { type: 'keyword' },
      status:       { type: 'keyword' },
      startAt:      { type: 'date' },
      endAt:        { type: 'date' },
      venueCity:    { type: 'keyword' },  // filtro exato; case-sensitive (normalizar no emit)
      venueState:   { type: 'keyword' },
      thumbnailUrl: { type: 'keyword', index: false }, // não indexar URLs
    },
  },
};
```

> **ES client v9 — tipagem estrita:** NÃO use `as const` aqui. O client
> `@elastic/elasticsearch` v9 tipa o body de `indices.create` com uniões
> discriminadas (`MappingProperty` por `type`). `as const` torna os arrays
> `readonly` e quebra a atribuição (`filter: readonly [...]` ≠ `string[]`). O
> objeto fica solto e fazemos **um único cast** no ponto de uso (Passo 8.2).

> **Nota sobre geo:** o capítulo 5 do tutorial não inclui `latitude/longitude`
> no schema de Event. Para habilitar busca por proximidade (`geo_distance`),
> primeiro adicione esses campos em `event-service/prisma/schema.prisma`,
> propague no `EventReplicatedEvent`, e só então acrescente
> `location: { type: 'geo_point' }` aqui. Manter o capítulo focado no que já
> existe.

---

## Passo 8.2 — `IndexBootstrapService` (cria o índice no startup)

O índice precisa existir antes do consumer começar a indexar. Usar
`indices.exists` + `create` com `ignore: 400` mantém o boot idempotente
(múltiplos pods sobem em paralelo e só um cria de fato).

```typescript
// apps/search-service/src/modules/search/index-bootstrap.service.ts

import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ElasticsearchService } from '@nestjs/elasticsearch';
import type { estypes } from '@elastic/elasticsearch';
import { EVENT_INDEX, EVENT_INDEX_MAPPING } from './event-index.js';

@Injectable()
export class IndexBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(IndexBootstrapService.name);

  constructor(private readonly es: ElasticsearchService) {}

  async onApplicationBootstrap(): Promise<void> {
    const exists = await this.es.indices.exists({ index: EVENT_INDEX });
    if (exists) {
      this.logger.log(`Índice "${EVENT_INDEX}" já existe`);
      return;
    }

    // Criar com mapping. Em produção, aliases + reindex zero-downtime
    // (ver runbooks/elasticsearch-reindex.md).
    //
    // O client ES v9 tipa o body com uniões discriminadas; objetos-literais
    // largam para `string` e não casam. Um cast único para
    // IndicesCreateRequest é o escape-hatch idiomático.
    await this.es.indices.create({
      index: EVENT_INDEX,
      ...EVENT_INDEX_MAPPING,
    } as estypes.IndicesCreateRequest);

    this.logger.log(`Índice "${EVENT_INDEX}" criado com mapping`);
  }
}
```

---

## Passo 8.3 — `SearchService` (query DSL)

A peça central. Constrói uma query `bool { must, filter }` — `must` afeta
score (relevância), `filter` não (cacheável).

```typescript
// apps/search-service/src/modules/search/search.service.ts

import { Injectable } from '@nestjs/common';
import { ElasticsearchService } from '@nestjs/elasticsearch';
// ES client v9: os tipos vêm do namespace `estypes` (o subpath
// '@elastic/elasticsearch/lib/api/types.js' NÃO resolve sob NodeNext/ESM).
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
            'title^3',               // título com peso 3x
            'title.autocomplete^2',  // autocomplete com peso 2x
            'slug',
          ],
          fuzziness: 'AUTO',
          prefix_length: 2,  // primeiras 2 letras devem estar corretas
          operator: 'and',   // todos os termos precisam aparecer
        },
      });
    }

    // ─── Filtros exatos (não afetam score, são cacheados pelo ES) ──────────
    if (params.city)  filterClauses.push({ term: { venueCity:  params.city  } });
    if (params.state) filterClauses.push({ term: { venueState: params.state } });

    // Apenas eventos em venda
    filterClauses.push({ term: { status: 'on_sale' } });

    // Apenas eventos futuros (sempre — exclui eventos já encerrados).
    // Objeto concreto (não Record) p/ permitir acesso por propriedade sob
    // noPropertyAccessFromIndexSignature.
    const dateRange: { gte: string; lte?: string } = {
      gte: new Date().toISOString(),
    };
    if (params.startAfter)  dateRange.gte = params.startAfter.toISOString();
    if (params.startBefore) dateRange.lte = params.startBefore.toISOString();
    filterClauses.push({ range: { startAt: dateRange } });

    // Com q: relevância depois data. Sem q: só cronológico.
    // ES v9 tipa `sort` estritamente — `_score` exige a forma objeto
    // (ScoreSort), não o atalho string `'desc'`.
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
```

---

## Passo 8.4 — `EventIndexer` (consumer Kafka)

Consome os mesmos `events.event-*` que o booking-service consome. Padrão
idêntico aos demais consumers do projeto: Zod safe-parse + idempotência via
`es.index({ id })` (mesmo id = update, sem PK violation).

```typescript
// apps/search-service/src/modules/indexer/event-indexer.controller.ts
//
// Consome events.event-* e mantém o índice "events" sincronizado.
// at-least-once do Kafka: usar es.index() com mesmo id é idempotente.

import { Controller, Logger } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { ElasticsearchService } from '@nestjs/elasticsearch';
import { KAFKA_TOPICS, EventReplicatedEventSchema } from '@showpass/types';
import { EVENT_INDEX } from '../search/event-index.js';
import { z } from 'zod';

@Controller()
export class EventIndexerController {
  private readonly logger = new Logger(EventIndexerController.name);

  constructor(private readonly es: ElasticsearchService) {}

  @EventPattern(KAFKA_TOPICS.EVENT_PUBLISHED)
  async onPublished(@Payload() raw: unknown): Promise<void> {
    return this.upsert(raw, 'EVENT_PUBLISHED');
  }

  @EventPattern(KAFKA_TOPICS.EVENT_UPDATED)
  async onUpdated(@Payload() raw: unknown): Promise<void> {
    return this.upsert(raw, 'EVENT_UPDATED');
  }

  /**
   * EVENT_CANCELLED tem payload diferente: { eventId, organizerId }.
   * É emitido em events.service.ts:transitionStatus quando status='cancelled'.
   */
  @EventPattern(KAFKA_TOPICS.EVENT_CANCELLED)
  async onCancelled(@Payload() raw: unknown): Promise<void> {
    const parsed = z
      .object({ eventId: z.uuid(), organizerId: z.uuid() })
      .safeParse(raw);
    if (!parsed.success) {
      this.logger.warn('EVENT_CANCELLED inválido', { issues: parsed.error.issues });
      return;
    }
    await this.removeFromIndex(parsed.data.eventId);
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private async upsert(raw: unknown, topic: string): Promise<void> {
    const parsed = EventReplicatedEventSchema.safeParse(raw);
    if (!parsed.success) {
      this.logger.error(`Payload inválido em ${topic}`, {
        issues: parsed.error.issues,
      });
      // Não relançar: nack infinito bloqueia a partição. Em prod: DLQ.
      return;
    }

    const e = parsed.data;

    // Só indexar status visíveis ao buyer; outros são removidos do índice.
    const indexable = ['published', 'on_sale', 'sold_out'];
    if (!indexable.includes(e.status)) {
      await this.removeFromIndex(e.id);
      return;
    }

    await this.es.index({
      index: EVENT_INDEX,
      id: e.id,
      document: {
        id: e.id,
        organizerId: e.organizerId,
        title: e.title,
        slug: e.slug,
        status: e.status,
        startAt: e.startAt,
        endAt: e.endAt,
        venueCity: e.venueCity,
        venueState: e.venueState,
        thumbnailUrl: e.thumbnailUrl,
      },
      // refresh: 'wait_for' garante read-your-write para o caller — útil em
      // testes E2E. Em prod com volume alto, omitir (default 'false') para
      // throughput.
      refresh: process.env['NODE_ENV'] === 'production' ? false : 'wait_for',
    });

    this.logger.log(`Indexado: ${e.id} ("${e.title}")`);
  }

  private async removeFromIndex(eventId: string): Promise<void> {
    try {
      await this.es.delete({ index: EVENT_INDEX, id: eventId });
      this.logger.log(`Removido do índice: ${eventId}`);
    } catch (err) {
      // 404 é benigno: evento pode nunca ter sido indexado (ex: cancelado
      // antes de chegar a 'published'). Outros erros são relançados.
      if ((err as { meta?: { statusCode?: number } }).meta?.statusCode !== 404) {
        throw err;
      }
    }
  }
}
```

---

## Passo 8.5 — `SearchController` (rotas públicas)

Sem `OrganizerGuard`/`BuyerGuard` — busca é pública. Validação Zod cobre
sanitização (OWASP A03).

```typescript
// apps/search-service/src/modules/search/search.controller.ts

import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import { SearchService } from './search.service.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';

const SearchQuerySchema = z.object({
  q:           z.string().min(1).optional(),
  city:        z.string().optional(),
  state:       z.string().length(2).optional(),
  startAfter:  z.coerce.date().optional(),
  startBefore: z.coerce.date().optional(),
  page:        z.coerce.number().int().min(1).default(1),
  limit:       z.coerce.number().int().min(1).max(100).default(20),
});

type SearchQuery = z.infer<typeof SearchQuerySchema>;

@Controller('search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  /**
   * Busca de eventos.
   * GET /search/events?q=Bruno+Mars&city=São%20Paulo&page=1
   */
  @Get('events')
  search(
    @Query(new ZodValidationPipe(SearchQuerySchema)) query: SearchQuery,
  ): ReturnType<SearchService['searchEvents']> {
    return this.searchService.searchEvents({
      ...(query.q          !== undefined ? { q:           query.q          } : {}),
      ...(query.city       !== undefined ? { city:        query.city       } : {}),
      ...(query.state      !== undefined ? { state:       query.state      } : {}),
      ...(query.startAfter !== undefined ? { startAfter:  query.startAfter } : {}),
      ...(query.startBefore!== undefined ? { startBefore: query.startBefore} : {}),
      page:  query.page,
      limit: query.limit,
    });
  }

  /**
   * Sugestões enquanto o usuário digita.
   * GET /search/autocomplete?q=ro → ["Rock in Rio 2025", ...]
   */
  @Get('autocomplete')
  async autocomplete(@Query('q') q: string): Promise<{ suggestions: string[] }> {
    if (!q || q.length < 2) return { suggestions: [] };
    const suggestions = await this.searchService.autocomplete(q);
    return { suggestions };
  }
}
```

---

## Passo 8.6 — `main.ts` híbrido (HTTP + Kafka)

Mesmo padrão do payment-service (cap-07): HTTP para `/search/*` + microservice
Kafka para os consumers.

```typescript
// apps/search-service/src/main.ts

import 'dotenv/config';
import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { Transport } from '@nestjs/microservices';
import type { MicroserviceOptions } from '@nestjs/microservices';
import { AppModule } from './app.module.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.KAFKA,
    options: {
      client: {
        clientId: process.env['KAFKA_CLIENT_ID'] ?? 'search-service',
        brokers: (process.env['KAFKA_BROKERS'] ?? 'localhost:29092').split(','),
      },
      consumer: {
        groupId:
          process.env['KAFKA_CONSUMER_GROUP_ID'] ?? 'search-service-consumer',
        allowAutoTopicCreation: false,
      },
    },
  });

  await app.startAllMicroservices();
  await app.listen(process.env['PORT'] ?? 3005);
}

void bootstrap();
```

---

## Passo 8.7 — Dependências, `AppModule`, `.env` e Makefile

> **Dependências (corrigir o scaffold):** o `apps/search-service/package.json`
> nasceu sem `@nestjs/elasticsearch` e com `@elastic/elasticsearch@^8`. O
> servidor é **ES 9.3** — alinhe o client major:
>
> ```jsonc
> // apps/search-service/package.json (dependencies)
> "@elastic/elasticsearch": "^9.0.0",
> "@nestjs/elasticsearch": "^11.0.0",
> // devDependencies: "dotenv": "^17.4.2", "@swc-node/register": "^1.10.0"
> ```
>
> **`tsconfig.json`:** **não** inclua `baseUrl` (nem `ignoreDeprecations`). O
> projeto usa `moduleResolution: NodeNext` — `baseUrl` é ignorado na resolução
> e só dispara o deprecation `TS5101` (que sob o TS pinado, 5.9.x, nem aceita
> `ignoreDeprecations: "6.0"` → `TS5103`). O template correto por serviço tem
> apenas `outDir`, `rootDir`, `experimentalDecorators`, `emitDecoratorMetadata`
> (ver cap-05).

```typescript
// apps/search-service/src/app.module.ts

import { Module } from '@nestjs/common';
import { ElasticsearchModule } from '@nestjs/elasticsearch';
import { KafkaModule } from '@showpass/kafka';

import { HealthModule } from './modules/health/health.module.js';
import { SearchController } from './modules/search/search.controller.js';
import { SearchService } from './modules/search/search.service.js';
import { IndexBootstrapService } from './modules/search/index-bootstrap.service.js';
import { EventIndexerController } from './modules/indexer/event-indexer.controller.js';

@Module({
  imports: [
    ElasticsearchModule.register({
      node: process.env['ELASTICSEARCH_NODE'] ?? 'http://localhost:9200',
      // Em prod: TLS + auth básica via env (ELASTICSEARCH_USERNAME/PASSWORD)
    }),
    KafkaModule.forRoot({
      clientId: process.env['KAFKA_CLIENT_ID'] ?? 'search-service',
      brokers: (process.env['KAFKA_BROKERS'] ?? 'localhost:29092').split(','),
      groupId:
        process.env['KAFKA_GROUP_ID'] ?? 'search-service-group',
    }),
    HealthModule,
  ],
  controllers: [SearchController, EventIndexerController],
  providers: [SearchService, IndexBootstrapService],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- padrão NestJS
export class AppModule {}
```

```bash
# apps/search-service/.env.example

NODE_ENV=development
PORT=3005
SERVICE_NAME=search-service

ELASTICSEARCH_NODE=http://localhost:9200

KAFKA_BROKERS=localhost:29092
KAFKA_CLIENT_ID=search-service
KAFKA_GROUP_ID=search-service-group
KAFKA_CONSUMER_GROUP_ID=search-service-consumer
```

E o `Makefile` ganha o serviço no `dev-services` (mesma estratégia dos
capítulos anteriores — ver cap-01 em "Como adicionar um novo microsserviço ao
`dev-services`").

---

## Backfill — indexar eventos pré-existentes

Domain events só são emitidos a partir do momento em que o search-service sobe.
Eventos publicados **antes** disso ficam fora do índice. Solução: **endpoint
administrativo no event-service** que reemite `EVENT_PUBLISHED` para todos
eventos em status indexável, e o search-service consome normalmente.

```typescript
// apps/event-service/src/modules/events/events.controller.ts (trecho novo)
//
// POST /events/admin/reindex — reemite EVENT_PUBLISHED para todos os eventos
// em status indexável. Idempotente: o consumer faz upsert por id.
//
// Proteção: require admin role (não implementado neste capítulo —
// usar OrganizerGuard com role check, ou guard dedicado AdminGuard).

@Post('admin/reindex')
@UseGuards(OrganizerGuard) // TODO: AdminGuard quando existir
async reindex(): Promise<{ reemitted: number }> {
  const events = await this.eventsRepo.findIndexable(); // status in (...)
  for (const e of events) {
    await this.kafka.emit(KAFKA_TOPICS.EVENT_PUBLISHED, {
      id: e.id, organizerId: e.organizerId, title: e.title, slug: e.slug,
      status: e.status, startAt: e.startAt, endAt: e.endAt,
      venueCity: e.venueCity, venueState: e.venueState,
      thumbnailUrl: e.thumbnailUrl,
    }, e.id);
  }
  return { reemitted: events.length };
}
```

---

## Testando na prática

### O que precisa estar rodando

```bash
# Terminal 1 — infraestrutura (Postgres + Kafka + Elasticsearch)
docker compose up -d
# Aguardar Elasticsearch inicializar
curl -s http://localhost:9200/_cluster/health | jq .status   # "yellow" ou "green"

# PRÉ-REQUISITO OBRIGATÓRIO — criar os tópicos Kafka ANTES de subir o serviço.
# O consumer roda com allowAutoTopicCreation:false; se subir antes de
# events.event-published/updated/cancelled existirem, o KafkaJS lança
# UNKNOWN_TOPIC_OR_PARTITION e DERRUBA o processo no boot.
./scripts/kafka-topics.sh                 # idempotente — cria os 17 tópicos

# Terminal 2 — serviços (auth + event + search)
make dev-services        # adicione search-service ao scripts/dev.sh
make dev-status          # confirme bolinhas verdes
```

> **Gotcha de infra (WSL/dev):** o Elasticsearch só fica acessível em
> `localhost:9200` se estiver na rede `public`. A rede `data` do
> `docker-compose.yml` é `internal: true` (bloqueia port binding — correto
> para prod). O `docker-compose.override.yml` adiciona `postgres`, `redis`,
> `kafka` **e `elasticsearch`** à rede `public` para o dev no host. Sem o
> bloco `elasticsearch:` no override, `docker compose ps` mostra a 9200 com
> `HostPort 0` (não publicada) e o search-service não conecta.

### Passo a passo

**1. Verificar que o índice foi criado no boot do search-service**

```bash
curl -s http://localhost:9200/events | jq '.events.mappings.properties | keys'
# ["endAt","id","organizerId","slug","startAt","status","thumbnailUrl","title","venueCity","venueState"]
```

**2. Criar e publicar um evento (event-service)**

```bash
ORGANIZER_TOKEN=$(curl -s -X POST http://localhost:3000/auth/organizers/login \
  -H "Content-Type: application/json" \
  -d '{"email":"organizador@ex.com","password":"Senha@123"}' | jq -r .accessToken)

EVENT_ID=$(curl -s -X POST http://localhost:3000/events \
  -H "Authorization: Bearer $ORGANIZER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"Rock in Rio 2026","startAt":"2026-09-26T18:00:00Z","endAt":"2026-09-30T23:00:00Z"}' \
  | jq -r .id)

# Transição draft → published → on_sale (cap-05 explica a state machine)
curl -s -X PATCH http://localhost:3000/events/$EVENT_ID/status \
  -H "Authorization: Bearer $ORGANIZER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status":"on_sale"}' | jq .status
# "on_sale" → event-service emite events.event-published no Kafka
```

**3. Buscar — texto livre**

```bash
sleep 2  # aguardar consumer indexar
curl -s 'http://localhost:3005/search/events?q=rock' | jq '.total, .hits[0].title'
# 1
# "Rock in Rio 2026"
```

**4. Busca com typo (fuzziness)**

```bash
# "rok" tem 1 edição para "Rock" → AUTO tolera
curl -s 'http://localhost:3005/search/events?q=rok+in+rio' | jq .total
# 1
```

**5. Filtro por estado**

```bash
curl -s 'http://localhost:3005/search/events?q=rock&state=RJ' | jq .total
```

**6. Autocomplete**

```bash
curl -s 'http://localhost:3005/search/autocomplete?q=ro' | jq .suggestions
# ["Rock in Rio 2026"]
```

**7. Cancelar evento — sai do índice**

```bash
curl -s -X PATCH http://localhost:3000/events/$EVENT_ID/status \
  -H "Authorization: Bearer $ORGANIZER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status":"cancelled"}'

sleep 1
curl -s 'http://localhost:3005/search/events?q=rock' | jq .total
# 0 — consumer recebeu EVENT_CANCELLED e fez delete
```

**8. Inspecionar o documento direto no Elasticsearch (debug)**

```bash
curl -s "http://localhost:9200/events/_doc/$EVENT_ID" | jq ._source
```

---

## Pegadinhas comuns

| Sintoma | Causa | Correção |
|---|---|---|
| Índice "events" não existe ao buscar | `IndexBootstrapService` não rodou (boot do app falhou) | Conferir log do bootstrap; ES está saudável (`/_cluster/health`)? |
| Busca retorna 0 mesmo após publicar | Consumer não recebeu o evento; ou `refresh: false` em prod e a leitura veio rápido demais | Conferir log do `EventIndexerController`; em test/dev usar `refresh: 'wait_for'` |
| `[parsing_exception] failed to parse field [startAt]` | Payload chegou com data em formato inesperado | `EventReplicatedEventSchema` usa `z.coerce.date()` — verificar emitter |
| `multi_match` ignora typos | `prefix_length: 2` exige as 2 primeiras letras corretas | Reduzir `prefix_length` para 0 (mais permissivo, mais ruído) |
| Alta latência com `refresh: 'wait_for'` em prod | Cada doc força refresh do shard | Não usar em prod — aceitar ~1s de delay para read-after-write |

---

## Próximos passos (fora do escopo deste capítulo)

1. **Geo search** — adicionar `latitude/longitude` em Event; propagar no
   `EventReplicatedEvent`; mapping `location: geo_point`; filtro
   `geo_distance` no `searchEvents`.
2. **Indexação denormalizada** (categoria, venue, organizer) — exige Outbox
   table no event-service; ver cap-18.
3. **Reindex zero-downtime** — alias + reindex; ver `runbooks/elasticsearch-reindex.md`.
4. **Highlight de matches** — `highlight: { fields: { title: {} } }` para
   destacar termos buscados na resposta.
5. **Aggregations** (filtros laterais) — facets de cidade, faixa de preço etc.
6. **CDC com Debezium** — quando volume justificar; ver cap-18.

---

## Recapitulando

1. **Domain events Kafka** sincronizam Elasticsearch — mesmo padrão dos demais
   bounded contexts (booking, payment), sem nova dependência (Debezium)
2. **Index mapping com analyzer português** — stemming + asciifolding +
   stopwords; "música" encontra "musica", "cantores" encontra "cantor"
3. **`multi_match` + `fuzziness: AUTO`** — tolerante a typos com
   `prefix_length: 2` para evitar matches absurdos
4. **`bool { must, filter }`** — `must` afeta score, `filter` é cacheável (e
   melhor para `term`/`range` exatos)
5. **`edge_ngram` para autocomplete** — sugestões em ~10ms enquanto o usuário
   digita
6. **Idempotência via `es.index({ id })`** — at-least-once do Kafka cobre
   reentrega de mensagens
7. **Backfill via reemissão de domain events** — endpoint admin que reemite
   para tudo que está em status indexável
8. **Trade-off explícito** — domain events vs CDC: começar simples, evoluir
   para Outbox + Debezium quando volume e governança exigirem (cap-18)

---

## Próximo capítulo

[Capítulo 9 → Worker Service](cap-09-worker-service.md)
