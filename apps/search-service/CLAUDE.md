# search-service — Gotchas para Claude

## Responsabilidade única
Busca full-text de eventos via Elasticsearch. Read-only em runtime: apenas consome
eventos do Kafka e indexa. Nunca escreve no banco do event-service.

---

## Invariantes críticas — NUNCA quebrar

### Mapeamento do índice (event-index.ts)
O índice `events` tem analisadores customizados para pt-BR:
- `portuguese_analyzer`: stemming + stopwords + remoção de acentos
- `autocomplete_analyzer`: edge_ngram para typeahead (busca parcial)

NUNCA alterar o mapeamento de um índice existente em produção sem reindexar.
Elasticsearch não permite mudança de tipo de campo in-place — causa `illegal_argument_exception`.
Para mudar o mapeamento: criar índice novo, reindexar, trocar alias.

### Campos indexados = campos do EventReplicatedEvent
O índice só tem campos que chegam no evento Kafka (`EventReplicatedEvent`):
```
id, organizerId, title, slug, status, startAt, endAt, venueCity, venueState, thumbnailUrl
```
`categoria`, `organizerName`, `venueName` NÃO estão no payload atual.
Para indexar campos extras, o event-service precisa aumentar o `EventReplicatedEvent`.
NÃO tentar ler do banco do event-service diretamente — viola isolamento de serviços.

### Reindex (runbook: docs/runbooks/elasticsearch-reindex.md)
Ao mudar o mapeamento, seguir o runbook de reindex — NÃO deletar o índice diretamente em prod.
`DELETE /events` em prod = busca indisponível até reindex completar.
Processo seguro: criar `events_v2` → reindexar → mover alias `events` → deletar `events_v1`.

### GET /search/events é público
Excluído do JwtAuthMiddleware no gateway (`search/*path`).
Qualquer mudança que exija autenticação nessa rota precisa TAMBÉM atualizar o gateway.

---

## Arquivos de alto risco
- `src/modules/search/event-index.ts` — mapeamento e analisadores do índice
- `src/modules/search/index-bootstrap.service.ts` — criação do índice no startup
- `src/modules/search/search.service.ts` — query DSL do Elasticsearch

## Dependências externas
- Elasticsearch 9.3 (porta 9200)
- Kafka: consome `events.event-published` e `events.event-updated`

## Gotchas do Elasticsearch
- `edge_ngram` aumenta significativamente o tamanho do índice. Ajustar `min_gram`/`max_gram` com cuidado.
- `portuguese_stemmer` pode reduzir recall para nomes próprios ("Shows" → "show").
- `asciifolding` permite buscar "musica" e achar "música" — manter sempre.
