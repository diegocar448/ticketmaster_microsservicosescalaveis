# payment-service — Gotchas para Claude

## Responsabilidade única
Processa pagamentos via Stripe, valida webhooks HMAC e emite PaymentConfirmedEvent no Kafka.
Mantém réplica local de buyers (via Kafka) para associar pagamentos sem depender do auth-service em runtime.

---

## Invariantes críticas — NUNCA quebrar

### Verificação HMAC do Stripe (OWASP A10)
O endpoint `POST /webhooks/stripe` DEVE verificar a assinatura HMAC-SHA256 antes de qualquer lógica.
Sem isso, qualquer pessoa pode POST e confirmar pagamentos falsos.

```typescript
// webhooks.controller.ts — ordem OBRIGATÓRIA:
const event = this.stripe.webhooks.constructEvent(
  req.rawBody,          // ← rawBody, não body parseado
  req.headers['stripe-signature'],
  this.webhookSecret,
);
// Só depois processar o event
```

### rawBody obrigatório no webhook
`req.rawBody` (não `req.body`) é necessário para validar a assinatura HMAC.
O `main.ts` configura `bodyParser: false` para a rota `/webhooks/*` por esse motivo.
NÃO ativar o body parser global para essa rota — quebra a validação HMAC.

### Idempotência no webhook
Stripe re-envia o mesmo evento por até 3 dias em caso de falha.
Sempre checar `order.status === 'paid'` antes de processar.
Processar duas vezes = cobrar duas vezes ou emitir dois ingressos.

### Webhook NOT via gateway em produção
O Stripe precisa alcançar o endpoint publicamente.
Em dev: `stripe listen --forward-to localhost:3002/webhooks/stripe`
Em prod: ingress dedicado → payment-service direto (pular o gateway evita que o gateway
         reparse o rawBody e quebre a verificação HMAC).

### Réplica de buyers (Kafka consumer)
O payment-service mantém réplica local de buyers para associar pagamentos sem depender do auth-service.
O consumer usa `upsert` — idempotente por design, retries do Kafka são seguros.
NUNCA deletar da tabela `buyers` diretamente: sincronizado via Kafka.

---

## Arquivos de alto risco
- `src/modules/webhooks/webhooks.controller.ts` — HMAC + idempotência
- `src/modules/buyers/buyers.consumer.ts` — réplica de buyers via Kafka
- `src/main.ts` — configuração do rawBody para o webhook

## Variáveis de ambiente críticas
```
STRIPE_SECRET_KEY      — chave secreta da Stripe (nunca expor)
STRIPE_WEBHOOK_SECRET  — segredo para validar HMAC dos webhooks
```
O service falha na inicialização se essas vars estiverem ausentes (fail-fast no constructor).

## Kafka: eventos consumidos e emitidos
```
Consome: auth.buyer.created  → replica buyer no banco local
Consome: auth.buyer.updated  → atualiza réplica
Emite:   payments.payment-confirmed → worker-service gera tickets + envia email
```
