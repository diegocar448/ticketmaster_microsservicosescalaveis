// apps/search-service/src/modules/search/event-index.ts
//
// Mapping do índice "events". Apenas campos QUE CHEGAM no
// EventReplicatedEvent (events.event-published/updated):
//   id, organizerId, title, slug, status, startAt, endAt,
//   venueCity, venueState, thumbnailUrl
//
// categoria/organizerName/venueName NÃO estão no payload — para indexá-los,
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
            'asciifolding', // remove acentos: "música" → "musica"
            'portuguese_stop', // remove stopwords PT-BR
            'portuguese_stemmer', // reduz à raiz: "cantores" → "cantor"
          ],
        },
        autocomplete_analyzer: {
          type: 'custom',
          tokenizer: 'standard',
          filter: ['lowercase', 'asciifolding', 'edge_ngram_filter'],
        },
      },
      filter: {
        portuguese_stop: { type: 'stop', stopwords: '_portuguese_' },
        portuguese_stemmer: { type: 'stemmer', language: 'portuguese' },
        edge_ngram_filter: { type: 'edge_ngram', min_gram: 2, max_gram: 20 },
      },
    },
  },
  mappings: {
    properties: {
      id: { type: 'keyword' },
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
      slug: { type: 'keyword' },
      status: { type: 'keyword' },
      startAt: { type: 'date' },
      endAt: { type: 'date' },
      venueCity: { type: 'keyword' }, // filtro exato; normalizar caixa no emit
      venueState: { type: 'keyword' },
      thumbnailUrl: { type: 'keyword', index: false }, // não indexar URLs
    },
  },
};
