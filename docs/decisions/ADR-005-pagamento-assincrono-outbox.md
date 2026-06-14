# ADR-005: Pagamento Assíncrono com Outbox Pattern

**Status:** Aceito  
**Data:** 2026-06

## Contexto
Num pico de mega-evento (~80M de acessos, ~50.000 checkouts concorrentes), chamar o Stripe de forma síncrona dentro da requisição do usuário derruba o sistema. A chamada externa leva 100–800ms; por Little's Law, 50.000 checkouts × 0,5s = 25.000 conexões travadas em I/O ao mesmo tempo — muito acima do pool disponível. Resultado observado: **timeout em cascata** ("o Stripe deu timeout sob carga"). Aumentar o timeout piora: segura a conexão por mais tempo e amplifica o retry storm.

## Alternativas consideradas

### Opção A: Chamada síncrona ao Stripe no request (estado anterior)
```typescript
const session = await stripe.checkout.sessions.create(...); // bloqueia o request
return { checkoutUrl: session.url };
```
**Problema:** a latência da rede externa entra no caminho quente. Sob carga, esgota o pool de conexões do Postgres e do event loop. Um incidente no Stripe vira um incidente no ShowPass.

### Opção B: Dual-write (INSERT order + produce Kafka, sem transação comum)
```typescript
await prisma.order.create(...);        // commit 1
await kafka.emit('charge-requested');  // commit 2 — e se cair aqui?
```
**Problema:** se o broker cai entre os dois, existe pedido sem evento de cobrança (pedido fantasma) — ou o inverso. Não há atomicidade entre Postgres e Kafka.

### Opção C: Outbox Pattern (escolhida)
```typescript
await prisma.$transaction(async (tx) => {
  const order = await tx.order.create({ data: { status: 'pending' } });
  await tx.paymentOutbox.create({ data: { topic: 'payments.charge-requested', payload } });
});
return { orderId, status: 'processing' }; // 202 imediato, NÃO espera o Stripe
```
**Vantagens:**
- Order e evento de cobrança no **mesmo commit** Postgres → "pedido existe ⇒ evento existe" (sem dual-write)
- O request responde 202 em milissegundos — a chamada ao Stripe sai do caminho quente
- Um `payment-worker` drena o outbox/fila e chama o Stripe **fora** do request, com Circuit Breaker (ADR — cap-18), Bulkhead (concorrência limitada) e Idempotency-Key
- Falha no Stripe não derruba o checkout: os eventos ficam na fila

## Decisão
Outbox transacional + worker de cobrança idempotente. O checkout grava intenção e responde 202; o worker processa a cobrança de forma assíncrona e resiliente. O cliente acompanha o status por polling/SSE.

## Invariantes
- Idempotência: a `idempotencyKey` do Order é a mesma enviada ao Stripe — reprocessar a fila não cobra duas vezes
- Antes de chamar o Stripe, checar `order.status === 'paid'` (retry do Kafka é seguro)
- Bulkhead: teto fixo de chamadas concorrentes ao Stripe (nunca 50k)
- Sucesso emite `payments.payment-confirmed`; a Saga (cap-18) confirma a reserva

## Consequências
- O fluxo deixa de ser "pague e receba o link na hora" e passa a "processando → confirmado" (UX precisa do estado intermediário)
- Requer um dispatcher que varre o outbox (`status='pending'`) e publica no Kafka
- Mensagens "envenenadas" vão para dead-letter, não travam a fila
- PIX encaixa naturalmente: assíncrono por natureza, alivia a pressão sobre o cartão/Stripe
- Ver `docs/cap-19-escala-extrema-antifraude.md` (Passo 19.4) para a implementação
