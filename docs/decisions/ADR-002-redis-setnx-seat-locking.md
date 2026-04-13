# ADR-002: Redis SETNX para Locks de Assentos

**Status:** Aceito  
**Data:** 2026-04

## Contexto
300.000 usuários tentam o mesmo assento simultaneamente. Precisamos garantir que apenas 1 consiga — sem double booking.

## Alternativas consideradas

### Opção A: SELECT FOR UPDATE (Pessimistic Locking no PostgreSQL)
```sql
BEGIN;
SELECT * FROM seats WHERE id = ? FOR UPDATE;
-- processar
COMMIT;
```
**Problema:** PostgreSQL suporta ~200 conexões simultâneas. Com 300.000 usuários, 99.9% ficariam na fila de conexão. O banco travaria.

### Opção B: Optimistic Locking (version column)
```sql
UPDATE seats SET status='reserved', version=version+1
WHERE id=? AND version=?
```
**Problema:** Em alta concorrência, taxa de conflito é ~99%. 299.999 usuários precisariam fazer retry em loop. Latência explode.

### Opção C: Redis SETNX (escolhida)
```
SET seat:lock:{eventId}:{seatId} {buyerId} NX EX 420
```
**Vantagens:**
- Redis processa 1M+ operações/segundo em single thread
- NX = atômico por design (não é possível race condition)
- EX = TTL automático (sem deadlock, sem cron de limpeza)
- Lua scripts para operações compostas (GET+DEL, GET+EXPIRE)

## Decisão
Redis SETNX com Lua scripts para operações atômicas compostas.

## Invariantes
- TTL: 7 minutos (Redis expira o lock; job expira a reserva no banco)
- All-or-nothing: N assentos → ou todos ou nenhum (com compensação)
- Verificação de disponibilidade: Redis (lock ativo) + PostgreSQL (status permanente)

## Consequências
- Dependência crítica do Redis — Circuit Breaker obrigatório
- Redis Cluster Sentinel HA em produção (failover < 30s)
- Redis não é fonte de verdade — PostgreSQL mantém o estado definitivo
