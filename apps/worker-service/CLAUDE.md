# worker-service — Gotchas para Claude

## Responsabilidade única
Consome eventos Kafka e executa tarefas assíncronas: gerar tickets/QR/PDF,
enviar emails e auditar mensagens mortas (DLT). Não expõe HTTP público.

---

## Invariantes críticas — NUNCA quebrar

### Idempotência é obrigatória em TODOS os consumers
Kafka at-least-once: a mesma mensagem pode chegar duas vezes (rebalance, retry).
`payment-confirmed.consumer.ts` verifica:
```typescript
const already = await this.prisma.ticket.count({ where: { orderId } });
if (already > 0) return; // já processado — não regerar
```
NUNCA remover essa checagem. Processar duas vezes = 2 QR Codes válidos para o mesmo
ingresso = fraude não detectada na catraca.

### Validação Zod antes de processar
TODO consumer valida o payload com `Schema.safeParse()` antes de qualquer lógica.
Payload inválido → DLT (Dead Letter Topic), não retry.
Retry de payload inválido = loop infinito até esgotar tentativas.

### DLT (Dead Letter Topic)
Mensagens que falham após retries vão para `<topic>.dlt`.
O `DlqAuditConsumer` escuta todos os `.dlt` e loga/alerta.
NUNCA silenciar erros sem enviar para o DLT — perda de dado de negócio.

### Email é best-effort
Falha no envio de email NÃO deve impedir a geração do ticket.
O ticket é o dado crítico; o email é notificação.
Estrutura correta:
```
1. Gerar ticket + QR + PDF  ← crítico, deve persistir
2. Tentar enviar email       ← best-effort, falha silenciosa
3. Em falha: logar, não relançar
```

### Réplicas locais (replicas/)
`buyers.consumer`, `events.consumer`, `ticket-batches.consumer` mantêm réplicas
locais para evitar dependência em runtime de outros serviços.
Todos usam `upsert` — idempotentes por design.
NÃO deletar réplicas diretamente: gerenciadas pelo Kafka.

---

## Arquivos de alto risco
- `src/modules/tickets/payment-confirmed.consumer.ts` — idempotência + geração de ticket
- `src/modules/dlq/dlq-audit.consumer.ts` — Dead Letter Topic
- `src/modules/replicas/` — 3 consumers de réplica (buyers, events, ticket-batches)

## Kafka: tópicos consumidos
```
payments.payment-confirmed   → gera Ticket + QR + PDF + email
auth.buyer.created/updated   → replica buyer no banco local
events.event-published/updated → replica evento no banco local
tickets.ticket-batch.created/updated → replica lote no banco local
payments.payment-confirmed.dlt → auditoria de mensagens mortas
```

## Dependência: sem HTTP externo
O worker-service não faz chamadas HTTP a outros serviços em runtime.
Tudo que precisa vem das réplicas locais (banco próprio).
Se precisar de dado que não está replicado: PRIMEIRO adicionar o consumer de réplica.

## Geração de QR Code
`ticket-generator.service.ts` gera QR Code com UUID único do ticket.
O UUID é a chave de validação na catraca — imutável após geração.
NUNCA regenerar o QR de um ticket existente.
