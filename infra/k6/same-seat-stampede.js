// infra/k6/same-seat-stampede.js
//
// O "300.000 pessoas no mesmo assento" — versão local e honesta.
//
// 500 compradores DIFERENTES (x-user-id distinto) disputam EXATAMENTE o mesmo
// assento, ao mesmo tempo. A invariante que provamos:
//
//   - EXATAMENTE 1 reserva tem sucesso (201)
//   - As outras 499 recebem 409 (assento indisponível)
//   - ZERO double booking
//
// Por que isso prova o sistema e não precisa de 80M:
// Uma race condition precisa de SIMULTANEIDADE na mesma chave, não de volume.
// Se o SETNX falhar, ele falha já com 2 requisições no mesmo instante — 500 é
// folga de sobra. Dobrar para 80M não tornaria um bug "mais visível"; o SETNX
// atômico do Redis ou segura 500 ou segura 80M (mesma operação O(1)).
//
// IMPORTANTE: JavaScript puro (runtime Goja/Go do k6), NÃO Node.js.
//
// Apontamos para :3004 (booking-service direto) e não :3000 (gateway): o gateway
// exige JWT real; aqui forjamos x-user-id, como o seat-reservation.js já fazia.

import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const success201 = new Counter('reservas_sucesso_201');
const conflict409 = new Counter('reservas_conflito_409');
const inesperado = new Counter('respostas_inesperadas');

export const options = {
  scenarios: {
    // per-vu-iterations: cada VU dispara UMA vez. 500 VUs sem sleep = enxurrada
    // quase simultânea no mesmo assento (o "thundering herd").
    stampede: {
      executor: 'per-vu-iterations',
      vus: Number(__ENV.VUS || 500),
      iterations: 1,
      maxDuration: '30s',
    },
  },
  thresholds: {
    // A INVARIANTE CRÍTICA, verificada automaticamente: NUNCA mais de 1 sucesso.
    // Se 2+ reservas passarem no mesmo assento, houve double booking → k6 falha.
    reservas_sucesso_201: ['count<2'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3004';
const EVENT_ID = __ENV.EVENT_ID;
const BATCH_ID = __ENV.BATCH_ID;
// Assento alvo: um UUID fixo (válido). Em booking o seatId é opaco (vira chave
// do lock no Redis) — não há FK. Para uma rodada limpa, varie SEAT_ID a cada run
// (o lock anterior dura 7 min). O script de run gera um novo a cada execução.
const SEAT_ID = __ENV.SEAT_ID || 'a0000000-0000-4000-8000-000000000001';
// buyerId vira coluna @db.Uuid com FK → precisa ser um buyer real e existente.
// Usamos um único buyer semeado para todos os VUs: o SETNX é keyed pelo ASSENTO
// (valor = buyerId), então mesmo com o mesmo buyer apenas 1 requisição vence o NX.
const BUYER_ID = __ENV.BUYER_ID;

export default function () {
  const res = http.post(
    `${BASE_URL}/bookings/reservations`,
    JSON.stringify({
      eventId: EVENT_ID,
      items: [{ ticketBatchId: BATCH_ID, seatId: SEAT_ID, quantity: 1 }],
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': BUYER_ID,
        'x-user-type': 'buyer',
      },
    },
  );

  if (res.status === 201) success201.add(1);
  else if (res.status === 409) conflict409.add(1);
  else {
    inesperado.add(1);
    console.error(`Resposta inesperada ${res.status}: ${res.body}`);
  }

  check(res, {
    'esperado (201 ou 409)': () => res.status === 201 || res.status === 409,
  });
}

// Resumo legível no fim — destaca o veredito da invariante.
export function handleSummary(data) {
  const ok = data.metrics.reservas_sucesso_201?.values.count ?? 0;
  const conflito = data.metrics.reservas_conflito_409?.values.count ?? 0;
  const erro = data.metrics.respostas_inesperadas?.values.count ?? 0;
  const veredito = ok === 1
    ? '✅ PASSOU — exatamente 1 reserva, ZERO double booking'
    : `❌ FALHOU — ${ok} reservas no mesmo assento (esperado: 1)`;
  const p95 = data.metrics.http_req_duration?.values['p(95)'] ?? 0;
  const reqs = data.metrics.http_reqs?.values.rate ?? 0;

  return {
    stdout: `
╔════════════════════════════════════════════════════════════╗
║  MESMO ASSENTO — ${String(__ENV.VUS || 500).padEnd(4)} compradores simultâneos               ║
╠════════════════════════════════════════════════════════════╣
║  Sucesso (201) ...... ${String(ok).padStart(4)}                                 ║
║  Conflito (409) ..... ${String(conflito).padStart(4)}                                 ║
║  Inesperado ......... ${String(erro).padStart(4)}                                 ║
╠════════════════════════════════════════════════════════════╣
║  ${veredito.padEnd(58)}║
╚════════════════════════════════════════════════════════════╝
  latência p95: ${p95.toFixed(0)} ms  ·  throughput: ${reqs.toFixed(0)} req/s
`,
  };
}
