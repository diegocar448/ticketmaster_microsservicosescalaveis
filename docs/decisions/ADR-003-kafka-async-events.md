# ADR-003: Kafka para Comunicação Assíncrona entre Serviços

**Status:** Aceito  
**Data:** 2026-04

## Contexto
Serviços precisam se comunicar. Quando um pagamento é confirmado, o Worker precisa gerar QR Code + PDF + e-mail. O Search Service precisa indexar eventos novos.

## Alternativas consideradas

### Opção A: HTTP síncrono (REST entre serviços)
Payment Service → POST /worker/generate-tickets → Worker Service
**Problemas:**
- Acoplamento temporal: se Worker estiver fora do ar, pagamento falha
- Stripe timeout: webhook deve retornar 200 em < 5s. Gerar PDF leva ~3s. Margem zero.
- Cascata de falhas: 1 serviço down derruba os que dependem dele

### Opção B: Kafka (escolhida)
Payment Service → emite `payments.payment-confirmed` → Worker consome quando disponível
**Vantagens:**
- Desacoplamento temporal: Worker pode estar fora por 10 min e processar ao voltar
- Backpressure natural: Worker processa no próprio ritmo
- Replay: se processamento falhar, Kafka retém a mensagem (configurável)
- DLT (Dead Letter Topic): mensagens que falham 3x vão para análise manual

## Decisão
Kafka 4.2 KRaft (sem ZooKeeper) para todos os domain events entre serviços.

## Tópicos e responsabilidades
```
bookings.reservation-created  → Payment Service cria order
payments.payment-confirmed     → Worker gera ingressos, Booking confirma reserva
payments.payment-failed        → Booking cancela reserva, Redis locks liberados
events.event-published         → Search Service indexa no Elasticsearch
```

## Consequências
- Consistência eventual (não imediata) entre serviços
- Idempotência obrigatória em todos os consumers (Kafka pode re-entregar)
- DLQ obrigatório — sem DLQ, falhas silenciosas causam ingressos não gerados
- Worker escala verticalmente (não horizontalmente além do número de partições)
