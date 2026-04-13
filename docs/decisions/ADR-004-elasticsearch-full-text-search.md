# ADR-004: Elasticsearch para Busca Full-Text

**Status:** Aceito  
**Data:** 2026-04

## Contexto
Usuários buscam eventos por nome, artista, cidade, data, categoria. Precisamos de busca que tolere typos e retorne resultados relevantes.

## Por que não PostgreSQL LIKE

```sql
-- Esta query NÃO funciona em grande escala:
SELECT * FROM events
WHERE name LIKE '%Bruno Mars%'
  AND start_date >= '2026-04-01'
```

Problemas:
- `LIKE '%palavra%'` = full table scan (sem índice B-tree)
- "Bruno Marz" não encontra "Bruno Mars" (sem fuzzy)
- "shows" não encontra "show" (sem stemming)
- Sem relevância (todos os resultados têm o mesmo peso)
- PostgreSQL full-text (`tsvector`) resolve parcialmente, mas sem geo, sem fuzziness automático

## Decisão
Elasticsearch 9.3 como motor de busca dedicado, sincronizado via CDC (Debezium + Kafka).

## Por que CDC e não escrita direta
- Event Service não conhece o Search Service (bounded context)
- Debezium lê o WAL do PostgreSQL — captura TODA mudança sem código adicional
- Se Search Service cair, o Kafka retém as mudanças para reprocessamento

## Recursos usados
- `portuguese_analyzer`: lowercase + asciifolding + stopwords PT-BR + stemmer
- `edge_ngram`: autocomplete (digitar "bru" retorna "Bruno Mars")
- `fuzziness: AUTO`: tolera 1-2 caracteres errados baseado no tamanho da palavra
- `geo_distance filter`: eventos em raio de X km do usuário
- `multi_match` com boost: título^3 > autocomplete^2 > descrição

## Stemming / similaridade
O `portuguese_stemmer` reduz palavras à raiz morfológica:
- "casinha", "casarão", "casebre" → raiz "cas" → buscar "casa" encontra todos
- "cantores", "cantando", "cantar" → raiz "cant" → buscar "cantor" encontra shows

## Consequências
- Consistência eventual entre PostgreSQL e Elasticsearch (delay < 1s via CDC)
- Elasticsearch não é fonte de verdade — sempre confirmar dados no PostgreSQL antes de reservar
- Index mapping precisa ser versionado — mudanças requerem reindex
