// infra/k6/cpf-limit-stampede.js
//
// O limite por CPF (cap-19) sob ataque de cambista, localmente.
//
// 200 reservas com o MESMO CPF, mas de compradores DIFERENTES (x-user-id
// distinto — simula o cambista usando várias contas). Ingressos de pista
// (general admission, sem assento específico), então o ÚNICO limitador é o
// contador atômico de CPF. A invariante:
//
//   - EXATAMENTE MAX_TICKETS_PER_CPF (default 4) reservas têm sucesso (201)
//   - Todas as demais recebem 409 (limite por CPF atingido)
//
// Prova que um CPF não fura o limite nem distribuindo a compra entre N contas —
// porque o contador é keyed por (eventId, cpf), não por buyerId.
//
// IMPORTANTE: JavaScript puro (runtime Goja/Go do k6), NÃO Node.js.

import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const success201 = new Counter('reservas_sucesso_201');
const conflict409 = new Counter('reservas_conflito_409');
const inesperado = new Counter('respostas_inesperadas');

// Deve bater com MAX_TICKETS_PER_CPF do booking-service (env do serviço).
const LIMITE = Number(__ENV.LIMITE || 4);

export const options = {
  scenarios: {
    cambista: {
      executor: 'per-vu-iterations',
      vus: Number(__ENV.VUS || 200),
      iterations: 1,
      maxDuration: '30s',
    },
  },
  thresholds: {
    // INVARIANTE CRÍTICA: nunca passar do limite, não importa a concorrência.
    reservas_sucesso_201: [`count<=${LIMITE}`],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3004';
const EVENT_ID = __ENV.EVENT_ID;
const BATCH_ID = __ENV.BATCH_ID;
// Mesmo CPF para todas as requisições (é o ponto do teste). Varie a cada rodada:
// o contador dura a janela de venda (default 24h). O script de run gera um CPF
// válido novo a cada execução.
const CPF = __ENV.CPF || '39053344705';
// Mesmo buyer real semeado para todos os VUs (FK @db.Uuid). O ponto do teste é o
// MESMO CPF: o contador é keyed por (eventId, cpf), independente do buyerId — por
// isso o limite de 4 vale mesmo que o cambista use N contas distintas.
const BUYER_ID = __ENV.BUYER_ID;

export default function () {
  const res = http.post(
    `${BASE_URL}/bookings/reservations`,
    JSON.stringify({
      eventId: EVENT_ID,
      cpf: CPF,
      // sem seatId = pista (general admission); o limitador é só o CPF
      items: [{ ticketBatchId: BATCH_ID, quantity: 1 }],
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

export function handleSummary(data) {
  const ok = data.metrics.reservas_sucesso_201?.values.count ?? 0;
  const conflito = data.metrics.reservas_conflito_409?.values.count ?? 0;
  const erro = data.metrics.respostas_inesperadas?.values.count ?? 0;
  const veredito = ok === LIMITE
    ? `✅ PASSOU — exatamente ${LIMITE} ingressos por CPF, nem 1 a mais`
    : `❌ FALHOU — ${ok} ingressos no mesmo CPF (esperado: ${LIMITE})`;
  const p95 = data.metrics.http_req_duration?.values['p(95)'] ?? 0;
  const reqs = data.metrics.http_reqs?.values.rate ?? 0;

  return {
    stdout: `
╔════════════════════════════════════════════════════════════╗
║  MESMO CPF — ${String(__ENV.VUS || 200).padEnd(4)} reservas simultâneas (limite ${String(LIMITE).padEnd(2)})         ║
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
