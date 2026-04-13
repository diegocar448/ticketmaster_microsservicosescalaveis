# Runbook: Redis Lock Leak

**Sintoma:** Assentos aparecem como "bloqueados" mas não há reserva ativa no banco.

## Diagnóstico

```bash
# 1. Listar todos os locks ativos para um evento
redis-cli -a $REDIS_PASSWORD KEYS "seat:lock:{eventId}:*"

# 2. Ver quem está com o lock e quando expira
redis-cli -a $REDIS_PASSWORD TTL "seat:lock:{eventId}:{seatId}"
redis-cli -a $REDIS_PASSWORD GET "seat:lock:{eventId}:{seatId}"

# 3. Verificar se há reserva pendente no banco
psql $DATABASE_URL -c "
  SELECT r.id, r.status, r.expires_at, ri.seat_id
  FROM reservations r
  JOIN reservation_items ri ON ri.reservation_id = r.id
  WHERE ri.seat_id = '{seatId}' AND r.status = 'pending'
"
```

## Causa mais comum
Lock existe no Redis mas reserva expirou/foi cancelada sem liberar o lock.
O `ReservationExpirationJob` roda a cada 2 minutos — pode haver delay.

## Resolução

```bash
# Aguardar TTL natural (máximo 7 minutos)
# OU forçar remoção apenas se confirmado que reserva não existe:

redis-cli -a $REDIS_PASSWORD DEL "seat:lock:{eventId}:{seatId}"
```

**ATENÇÃO:** Só deletar o lock manualmente se confirmado que não há reserva pendente no banco. Deletar um lock ativo causa double booking.

## Prevenção
O `ReservationExpirationJob` faz `releaseMultiple()` após expirar reservas.
Se o job não estiver rodando, verificar: `kubectl logs -l app=booking-service -n showpass | grep ExpirationJob`
