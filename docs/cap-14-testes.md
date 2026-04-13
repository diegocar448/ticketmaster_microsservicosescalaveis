# Capítulo 14 — Testes

> **Objetivo:** Estratégia de testes para um sistema distribuído — Jest (unit), Supertest (E2E por serviço), Playwright (E2E browser), e k6 (load test da reserva concorrente).

## Passo 14.1 — Testes Unitários: SeatLockService

```typescript
// apps/booking-service/src/modules/locks/seat-lock.service.spec.ts

import { Test } from '@nestjs/testing';
import { SeatLockService } from './seat-lock.service';
import { RedisService } from '@showpass/redis';

// Mock do RedisService — testes unitários não devem tocar infraestrutura
const mockRedis = {
  acquireLock: jest.fn(),
  releaseLock: jest.fn(),
  get: jest.fn(),
};

describe('SeatLockService', () => {
  let service: SeatLockService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        SeatLockService,
        { provide: RedisService, useValue: mockRedis },
      ],
    }).compile();

    service = module.get(SeatLockService);
    jest.clearAllMocks();
  });

  describe('acquireMultiple', () => {
    it('deve adquirir todos os locks e retornar success: true', async () => {
      mockRedis.acquireLock.mockResolvedValue(true);

      const result = await service.acquireMultiple(
        'event-123',
        ['seat-A', 'seat-B', 'seat-C'],
        'buyer-456',
      );

      expect(result.success).toBe(true);
      expect(result.unavailableSeatIds).toHaveLength(0);
      expect(mockRedis.acquireLock).toHaveBeenCalledTimes(3);
    });

    it('deve liberar locks adquiridos quando um falha (compensação)', async () => {
      // Primeiro adquire, segundo falha
      mockRedis.acquireLock
        .mockResolvedValueOnce(true)   // seat-A: OK
        .mockResolvedValueOnce(false)  // seat-B: FAIL
        .mockResolvedValueOnce(true);  // seat-C: OK (não deve chegar aqui)

      mockRedis.releaseLock.mockResolvedValue(true);

      const result = await service.acquireMultiple(
        'event-123',
        ['seat-A', 'seat-B', 'seat-C'],
        'buyer-456',
      );

      expect(result.success).toBe(false);
      expect(result.unavailableSeatIds).toEqual(['seat-B']);

      // Deve liberar o seat-A que foi adquirido antes da falha
      expect(mockRedis.releaseLock).toHaveBeenCalledWith(
        expect.stringContaining('seat-A'),
        'buyer-456',
      );
    });

    it('deve retornar todos os seatIds indisponíveis quando múltiplos falham', async () => {
      mockRedis.acquireLock.mockResolvedValue(false);

      const result = await service.acquireMultiple(
        'event-123',
        ['seat-A', 'seat-B'],
        'buyer-456',
      );

      expect(result.success).toBe(false);
      expect(result.unavailableSeatIds).toEqual(['seat-A', 'seat-B']);
    });
  });
});
```

---

## Passo 14.2 — Teste de Integração: Reservations Controller

```typescript
// apps/booking-service/test/e2e/reservations.e2e-spec.ts
//
// Teste E2E com Supertest — testa a stack completa (controllers, services, prisma).
// Usa um banco de dados de teste (DATABASE_URL do .env.test).

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';

describe('Reservations E2E', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let buyerToken: string;
  let testEventId: string;
  let testBatchId: string;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe());
    await app.init();

    prisma = app.get(PrismaService);

    // Preparar dados de teste
    await setupTestData();

    // Obter token de buyer
    buyerToken = await getBuyerToken();
  });

  afterAll(async () => {
    await cleanupTestData();
    await app.close();
  });

  it('POST /bookings/reservations deve criar reserva quando assentos disponíveis', async () => {
    const response = await request(app.getHttpServer())
      .post('/bookings/reservations')
      .set('x-user-id', 'test-buyer-id')
      .set('x-user-type', 'buyer')
      .send({
        eventId: testEventId,
        items: [{ ticketBatchId: testBatchId, quantity: 1 }],
      });

    expect(response.status).toBe(201);
    expect(response.body).toHaveProperty('id');
    expect(response.body.status).toBe('pending');
    expect(new Date(response.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('POST /bookings/reservations deve retornar 409 quando assento já reservado', async () => {
    const seatId = 'existing-locked-seat-id';

    // Primeira reserva
    await request(app.getHttpServer())
      .post('/bookings/reservations')
      .set('x-user-id', 'buyer-1')
      .set('x-user-type', 'buyer')
      .send({
        eventId: testEventId,
        items: [{ ticketBatchId: testBatchId, seatId, quantity: 1 }],
      });

    // Segunda reserva do mesmo assento por outro buyer
    const response = await request(app.getHttpServer())
      .post('/bookings/reservations')
      .set('x-user-id', 'buyer-2')
      .set('x-user-type', 'buyer')
      .send({
        eventId: testEventId,
        items: [{ ticketBatchId: testBatchId, seatId, quantity: 1 }],
      });

    expect(response.status).toBe(409);
    expect(response.body).toHaveProperty('unavailableSeatIds');
    expect(response.body.unavailableSeatIds).toContain(seatId);
  });

  async function setupTestData(): Promise<void> {
    // Criar dados mínimos para os testes
    // (em projetos maiores: usar factories)
  }

  async function cleanupTestData(): Promise<void> {
    await prisma.reservation.deleteMany({ where: { eventId: testEventId } });
  }

  async function getBuyerToken(): Promise<string> {
    // Obter token via auth service
    return 'test-jwt-token';
  }
});
```

---

## Passo 14.3 — Teste de Concorrência (o mais importante)

```typescript
// apps/booking-service/test/e2e/concurrency.e2e-spec.ts
//
// Testa o cenário de alta concorrência: 50 buyers tentando o mesmo assento.
// Apenas 1 deve conseguir reservar — todos os outros devem receber 409.

describe('Concorrência: Double Booking Prevention', () => {
  it('deve permitir apenas 1 reserva quando 50 buyers tentam o mesmo assento', async () => {
    const sharedSeatId = 'concurrency-test-seat-id';
    const buyerIds = Array.from({ length: 50 }, (_, i) => `concurrent-buyer-${i}`);

    // Disparar todas as reservas simultaneamente
    const results = await Promise.allSettled(
      buyerIds.map((buyerId) =>
        request(app.getHttpServer())
          .post('/bookings/reservations')
          .set('x-user-id', buyerId)
          .set('x-user-type', 'buyer')
          .send({
            eventId: testEventId,
            items: [{ ticketBatchId: testBatchId, seatId: sharedSeatId, quantity: 1 }],
          }),
      ),
    );

    const successful = results.filter(
      (r) => r.status === 'fulfilled' && r.value.status === 201,
    );
    const failed = results.filter(
      (r) => r.status === 'fulfilled' && r.value.status === 409,
    );

    // Exatamente 1 sucesso, 49 conflitos
    expect(successful).toHaveLength(1);
    expect(failed).toHaveLength(49);

    // Verificar que apenas 1 reserva existe no banco
    const reservationsInDb = await prisma.reservation.count({
      where: { eventId: testEventId, status: 'pending' },
    });
    expect(reservationsInDb).toBe(1);
  }, 30_000);  // timeout de 30s para o teste de concorrência
});
```

---

## Passo 14.4 — Playwright E2E

```typescript
// apps/web/e2e/checkout-flow.spec.ts

import { test, expect } from '@playwright/test';

test.describe('Checkout Flow', () => {
  test('comprador consegue reservar assento e iniciar checkout', async ({ page }) => {
    // Login
    await page.goto('/buyer/login');
    await page.fill('[data-testid="email"]', 'buyer@test.com');
    await page.fill('[data-testid="password"]', 'Test1234!');
    await page.click('[data-testid="submit"]');
    await expect(page).toHaveURL('/');

    // Navegar para um evento
    await page.goto('/events/show-teste');
    await expect(page.locator('h1')).toContainText('Show Teste');

    // Selecionar assento disponível
    const availableSeat = page.locator('[aria-label*="Disponível"]').first();
    await availableSeat.click();
    await expect(availableSeat).toHaveAttribute('aria-pressed', 'true');

    // Clicar em Reservar
    await page.click('[data-testid="reserve-button"]');

    // Deve ir para checkout
    await expect(page).toHaveURL(/\/checkout\?reservation=/);
    await expect(page.locator('[data-testid="reservation-timer"]')).toBeVisible();

    // Verificar que o timer mostra 15 minutos
    const timerText = await page.locator('[data-testid="reservation-timer"]').textContent();
    expect(timerText).toMatch(/14:[0-5][0-9]/);
  });
});
```

---

## Passo 14.5 — k6 Load Test

```javascript
// infra/k6/seat-reservation.js
//
// Simula 1000 usuários tentando reservar ingressos simultaneamente.
// Mede: taxa de sucesso, latência P95/P99, throughput.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const errorRate = new Rate('errors');
const reservationDuration = new Trend('reservation_duration', true);

export const options = {
  stages: [
    { duration: '30s', target: 100 },   // ramp up
    { duration: '1m', target: 1000 },   // pico: 1000 usuários simultâneos
    { duration: '30s', target: 0 },     // ramp down
  ],
  thresholds: {
    http_req_duration: ['p(95)<500'],    // 95% das requests < 500ms
    errors: ['rate<0.05'],               // menos de 5% de erros inesperados
  },
};

const BASE_URL = __ENV.BASE_URL ?? 'http://localhost:3001';

export default function (): void {
  const userId = `load-buyer-${__VU}-${__ITER}`;
  const eventId = __ENV.EVENT_ID ?? 'load-test-event-id';
  const batchId = __ENV.BATCH_ID ?? 'load-test-batch-id';

  const startTime = Date.now();

  const response = http.post(
    `${BASE_URL}/bookings/reservations`,
    JSON.stringify({
      eventId,
      items: [{ ticketBatchId: batchId, quantity: 1 }],
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

  // 201 = sucesso, 409 = assento indisponível (esperado em alta concorrência)
  const isExpectedResponse = response.status === 201 || response.status === 409;

  check(response, {
    'resposta esperada (201 ou 409)': () => isExpectedResponse,
    'latência < 500ms': () => response.timings.duration < 500,
  });

  errorRate.add(!isExpectedResponse);

  sleep(0.1);
}
```

```bash
# Executar o load test
k6 run --env EVENT_ID=xxx --env BATCH_ID=yyy infra/k6/seat-reservation.js

# Resultado esperado:
# ✓ resposta esperada (201 ou 409): 99.8%
# ✓ latência < 500ms: 96.2%
# http_req_duration p(95)=287ms p(99)=412ms
```

---

## Recapitulando

1. **Jest unit tests** — mockar infraestrutura (Redis, Prisma); testar lógica de negócio isolada
2. **Supertest E2E** — testar controllers com banco real; detectar bugs de integração
3. **Concurrency test** — 50 buyers no mesmo assento; garantir que apenas 1 passa
4. **Playwright** — testar fluxo completo no browser; detectar regressões de UI
5. **k6 load test** — validar que o sistema aguenta 1000 usuários simultâneos com P95 < 500ms

---

## Próximo capítulo

[Capítulo 15 → CI/CD](cap-15-cicd.md)
