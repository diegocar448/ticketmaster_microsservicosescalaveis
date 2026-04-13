# Runbook: Re-indexar Elasticsearch

**Quando usar:** Após mudança no index mapping, ou quando busca retorna resultados desatualizados.

## Re-index completo

```bash
# 1. Criar novo índice com mapping atualizado
curl -X PUT http://localhost:9200/events_v2 \
  -H 'Content-Type: application/json' \
  -d @infra/elasticsearch/event-mapping.json

# 2. Re-indexar do índice atual para o novo
curl -X POST http://localhost:9200/_reindex \
  -H 'Content-Type: application/json' \
  -d '{
    "source": { "index": "events" },
    "dest": { "index": "events_v2" }
  }'

# 3. Atualizar alias (zero downtime)
curl -X POST http://localhost:9200/_aliases \
  -H 'Content-Type: application/json' \
  -d '{
    "actions": [
      { "remove": { "index": "events",    "alias": "events_alias" } },
      { "add":    { "index": "events_v2", "alias": "events_alias" } }
    ]
  }'

# 4. Deletar índice antigo após confirmar que v2 está ok
curl -X DELETE http://localhost:9200/events
```

## Re-indexar via CDC (mais seguro)
Se o Debezium estiver rodando, basta dropar o índice e deixar o CDC repovoar:
```bash
# Dropar e recriar o índice (CDC repovoará nos próximos segundos)
curl -X DELETE http://localhost:9200/events
# Search Service recria o índice automaticamente ao receber próxima mensagem CDC
```

## Verificar saúde do índice
```bash
curl http://localhost:9200/_cluster/health
curl http://localhost:9200/events/_count
curl http://localhost:9200/events/_search?q=test&size=1
```
