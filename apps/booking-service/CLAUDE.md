# booking-service — Gotchas para Claude

## O problema que este serviço resolve
300.000 pessoas tentam o mesmo assento. Redis SETNX garante que apenas 1 consegue.
Leia `docs/cap-06-booking-service.md` antes de qualquer alteração.

## Invariantes críticas — NUNCA quebrar

### TTL do lock = 7 minutos
`LOCK_TTL_SECONDS = 7 * 60` em `seat-lock.service.ts`
`RESERVATION_TTL_MINUTES = 7` em `reservations.service.ts`
Os dois devem ser iguais. O Redis expira o lock; o cron job expira a reserva no banco.

### All-or-nothing em acquireMultiple()
Se N assentos são solicitados e 1 falha → TODOS os locks adquiridos são liberados (compensação).
NUNCA retornar sucesso parcial. O comprador não pode ficar com locks de outros assentos.

### Verificação de disponibilidade = Redis + PostgreSQL
Um assento está disponível somente se:
1. `status = 'available'` no PostgreSQL (não foi vendido)
2. Sem lock no Redis (não está em checkout)
Verificar só o banco OU só o Redis é INCORRETO.

### Lua scripts são atômicos
`releaseLock` e `renewLock` usam Lua para garantir atomicidade do GET+DEL.
NUNCA substituir por comandos Redis separados — cria race condition.

### Limite por CPF é atômico (cap-19)
`CpfLimitService.consume()` usa `RedisService.tryConsumeWithLimit` (Lua check-and-increment)
para garantir "no máximo N ingressos por CPF" sob alta concorrência.
NUNCA trocar por `SELECT count(*)` + `INSERT` — é a mesma race condition que o SETNX evita.
O `consume()` roda ANTES dos locks e devolve uma função de COMPENSAÇÃO (rollback do contador);
se uma etapa posterior falhar, ela DEVE ser chamada — igual ao release dos locks.
Limite via env `MAX_TICKETS_PER_CPF` (default 4). CPF nunca é persistido cru (hash + pepper, LGPD).

## Arquivos de alto risco
- `src/modules/locks/seat-lock.service.ts` — núcleo do sistema anti-double-booking
- `src/modules/reservations/reservations.service.ts` — fluxo de 6 passos
- `src/modules/reservations/cpf-limit.service.ts` — limite atômico por CPF (cap-19)
- `src/modules/sagas/booking.saga.ts` — compensação via eventos Kafka

## Dependências externas
- `@showpass/redis` — RedisService com acquireLock/releaseLock/Lua
- `@showpass/kafka` — KafkaProducerService para domain events
- Event Service via gRPC — verificar status do evento antes de reservar
