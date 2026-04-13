# packages/redis — Gotchas para Claude

## Este pacote é o coração do sistema anti-double-booking
Os Lua scripts em `redis.service.ts` são ATÔMICOS no Redis.
Qualquer alteração pode criar race conditions que permitem double booking.

## acquireLock — SET NX EX
`SET key value NX EX ttl`
NX = só seta se NÃO existir (atômico — impossível race condition).
Nunca substituir por GET + SET separados.

## releaseLock — Lua script GET+DEL
```lua
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
```
Garante que só o DONO libera o lock.
Sem Lua: GET retorna ownerA, outro processo seta ownerB, DEL libera o lock de B. Bug crítico.

## renewLock — Lua script GET+EXPIRE
Mesma lógica: só renova se ainda for o dono.
Usado quando checkout demora mais que 7 minutos.

## Circuit Breaker (packages/redis/src/circuit-breaker.ts)
Envolve chamadas Redis com opossum.
Se Redis cair: fallback retorna `false` (lock não adquirido) → reserva rejeitada com mensagem amigável.
Não remover — sem ele, uma falha do Redis derruba o Booking Service inteiro.
