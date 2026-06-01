// infra/k6/seat-reservation.js
//
// Simula 1000 usuários tentando reservar ingressos simultaneamente.
// Mede: taxa de sucesso, latência P95/P99, throughput.
//
// IMPORTANTE: este arquivo é JavaScript puro — roda no runtime Goja (Go),
// NÃO em Node.js. Anotações de tipo TypeScript causam erro de parse.
//
// Por que apontamos para :3004 e não :3000 (API Gateway)?
// O gateway exige JWT real no Authorization header. Em load test forjamos
// x-user-id diretamente — o gateway bloquearia isso. Em produção NUNCA
// exponha o booking-service diretamente; aqui é só para teste de carga.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const errorRate = new Rate('errors');
const reservationDuration = new Trend('reservation_duration', true);

export const options = {
  stages: [
    { duration: '30s', target: 100 },   // ramp up: 0 → 100 usuários
    { duration: '1m',  target: 1000 },  // pico: 1000 usuários simultâneos
    { duration: '30s', target: 0 },     // ramp down
  ],
  thresholds: {
    // SLA: 95% das requests abaixo de 500ms
    http_req_duration: ['p(95)<500'],
    // Taxa de erro (respostas inesperadas) < 5%
    // 409 é ESPERADO em alta concorrência — não é erro
    errors: ['rate<0.05'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3004';
const EVENT_ID = __ENV.EVENT_ID || 'load-test-event-id';
const BATCH_ID = __ENV.BATCH_ID || 'load-test-batch-id';

export default function () {
  const userId = `load-buyer-${__VU}-${__ITER}`;

  const startTime = Date.now();

  const response = http.post(
    `${BASE_URL}/bookings/reservations`,
    JSON.stringify({
      eventId: EVENT_ID,
      items: [{ ticketBatchId: BATCH_ID, quantity: 1 }],
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': userId,
        'x-user-type': 'buyer',
      },
    },
  );

  reservationDuration.add(Date.now() - startTime);

  // 201 = reserva criada, 409 = assento indisponível (esperado — não é erro)
  const isExpectedResponse = response.status === 201 || response.status === 409;

  check(response, {
    'resposta esperada (201 ou 409)': () => isExpectedResponse,
    'latência < 500ms': () => response.timings.duration < 500,
  });

  errorRate.add(!isExpectedResponse);

  sleep(0.1);
}
