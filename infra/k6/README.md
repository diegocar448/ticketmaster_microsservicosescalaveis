# Testes de carga (k6)

Três cenários. Todos são **JavaScript puro** (runtime Goja/Go do k6, **não** Node.js —
anotações de tipo TS quebram o parser).

| Arquivo | O que mede | Invariante provada |
|---|---|---|
| `seat-reservation.js` | Throughput/latência sob carga (1000 VUs em rampa) | SLA p95 < 500ms |
| `same-seat-stampede.js` | 500 compradores no **mesmo assento** ao mesmo tempo | **Zero double booking** — exatamente 1 reserva (201), resto 409 |
| `cpf-limit-stampede.js` | 200 reservas com o **mesmo CPF** em paralelo | **Limite por CPF** (cap-19) — exatamente `MAX_TICKETS_PER_CPF` (4) passam |

Por que os dois "stampede" provam o sistema sem precisar de 80M: uma race condition
precisa de **simultaneidade na mesma chave**, não de volume. 500 batendo no mesmo
instante já exporiam qualquer falha do SETNX/contador atômico. Ambos têm um
**threshold que falha o teste automaticamente** se a invariante quebrar
(`reservas_sucesso_201: ['count<2']` e `['count<=4']`).

## ⚠️ Gotcha — WSL2 / Docker Desktop: rode o k6 NATIVO no host

Os serviços de dev (booking-service etc.) rodam **no host** (via `pnpm dev`), em
`localhost:3004`. O k6 dentro de um container (`grafana/k6` com `--network host` ou
`host.docker.internal`) **não alcança** o host no Docker Desktop/WSL2 — todas as
requisições voltam status `0`. Solução: baixar o binário nativo do k6 e rodá-lo no host.

```bash
# binário nativo (sem sudo) — uma vez
VER=$(curl -s https://api.github.com/repos/grafana/k6/releases/latest | grep -oP '"tag_name":\s*"\K[^"]+')
curl -sL "https://github.com/grafana/k6/releases/download/${VER}/k6-${VER}-linux-amd64.tar.gz" | tar xz -C /tmp
ln -sf "$(find /tmp -name k6 -type f -path '*linux-amd64*' | head -1)" /tmp/k6
```

## Pré-requisitos (dados semeados)

Os scripts precisam de um evento `on_sale` + um lote + um buyer real (FK `@db.Uuid`).
Suba a infra e os serviços, e tenha em mãos `EVENT_ID`, `BATCH_ID` e `BUYER_ID`:

```bash
make infra-up                                       # postgres, redis, kafka
pnpm --filter @showpass/event-service  run dev      # :3003 (public-meta)
pnpm --filter @showpass/booking-service run dev      # :3004 (alvo do teste)
# semear um evento on_sale + lote (events DB) e um buyer + réplica do lote (booking DB)
# — ver os INSERTs no histórico ou crie via os endpoints de organizer/auth.
```

## Rodar

```bash
# 1) Mesmo assento — prova zero double booking. SEAT_ID novo a cada run (lock dura 7 min).
BASE_URL=http://localhost:3004 \
EVENT_ID=$EVENT_ID BATCH_ID=$BATCH_ID BUYER_ID=$BUYER_ID \
SEAT_ID=$(python3 -c "import uuid;print(uuid.uuid4())") VUS=500 \
  /tmp/k6 run same-seat-stampede.js

# 2) Mesmo CPF — prova o limite. CPF válido novo a cada run (contador dura 24h).
BASE_URL=http://localhost:3004 \
EVENT_ID=$EVENT_ID BATCH_ID=$BATCH_ID BUYER_ID=$BUYER_ID \
CPF=39053344705 VUS=200 LIMITE=4 \
  /tmp/k6 run cpf-limit-stampede.js
```

> **Por que variar SEAT_ID/CPF a cada run:** o lock do assento dura 7 min e o contador
> de CPF dura a janela de vendas (default 24h). Reusar a mesma chave numa 2ª rodada
> daria "0 sucessos" (tudo já travado/no limite) — comportamento correto, mas confuso
> para demonstração. Os comandos acima geram chaves novas automaticamente.

## Exemplo de saída (medido localmente, 1 instância dev, WSL2)

```
MESMO ASSENTO — 500 compradores:  1 sucesso · 499 conflito · ✅ ZERO double booking · p95 5364ms
MESMO CPF      — 200 reservas:     4 sucesso · 196 conflito · ✅ nem 1 a mais        · p95 2755ms
```

O p95 alto é **proposital de observar**: uma única instância dev sendo socada por 500
conexões simultâneas é o gargalo aparecendo em miniatura — a mesma curva que produção
resolve com HPA, Fan Gate (absorve na borda) e pagamento assíncrono (cap-19).
