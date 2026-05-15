# Capítulo 14 — Testes

> **Objetivo:** Estratégia de testes para um sistema distribuído — Jest (unit), Supertest (E2E por serviço), Playwright (E2E browser), e k6 (load test da reserva concorrente).

## Passo 14.1 — Testes Unitários: SeatLockService

O teste unitário do `SeatLockService` é o mais puro: sem Docker, sem Redis real, sem banco.
O Redis é **mockado** porque o objetivo aqui é testar a lógica de compensação all-or-nothing
(se um lock falha, os anteriores devem ser liberados), não a atomicidade do Redis.
A atomicidade do SETNX será provada no Passo 14.3.

```typescript
// apps/booking-service/src/modules/locks/seat-lock.service.spec.ts
//
// NodeNext/ESM: imports relativos DEVEM ter extensão .js mesmo em .ts
// (o compilador resolve para o .js em runtime).

import { Test } from '@nestjs/testing';
import { SeatLockService } from './seat-lock.service.js';
import { RedisService } from '@showpass/redis';

// Mock do RedisService — testes unitários não devem tocar infraestrutura.
// Testamos a lógica de compensação: se acquireLock falha no meio,
// os locks já adquiridos devem ser revertidos (releaseLock chamado).
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

    it('deve liberar locks adquiridos quando um falha (compensação all-or-nothing)', async () => {
      // Primeiro adquire, segundo falha — o terceiro não deve nem ser tentado.
      // PORQUÊ: manter consistência; um buyer não pode sair com lock parcial.
      mockRedis.acquireLock
        .mockResolvedValueOnce(true)   // seat-A: OK
        .mockResolvedValueOnce(false)  // seat-B: FAIL
        .mockResolvedValueOnce(true);  // seat-C: não deve ser chamado

      mockRedis.releaseLock.mockResolvedValue(true);

      const result = await service.acquireMultiple(
        'event-123',
        ['seat-A', 'seat-B', 'seat-C'],
        'buyer-456',
      );

      expect(result.success).toBe(false);
      expect(result.unavailableSeatIds).toEqual(['seat-B']);

      // seat-A foi adquirido antes da falha — deve ser liberado
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
// Teste E2E com Supertest — testa a stack completa (controllers, services, prisma, Redis).
// Requer banco e Redis reais (DATABASE_URL e REDIS_URL do .env.test).
//
// NodeNext/ESM: default import do supertest, NÃO namespace import.
// `import * as request` não funciona com ESM — use `import request from 'supertest'`.

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';  // default import — ESM/NodeNext exige isso
import { AppModule } from '../../src/app.module.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';

// PORQUÊ não registramos ValidationPipe aqui:
// O projeto usa ZodValidationPipe aplicado por rota via @Body(new ZodValidationPipe(Schema)).
// Registrar ValidationPipe globalmente seria redundante e conflitaria com a validação Zod
// já declarada nos controllers. O AppModule já carrega tudo que precisa.
describe('Reservations E2E', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let testEventId: string;
  let testBatchId: string;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = module.createNestApplication();
    // Sem app.useGlobalPipes(new ValidationPipe()) — ver comentário acima.
    await app.init();

    prisma = app.get(PrismaService);

    await setupTestData();
  });

  afterAll(async () => {
    await cleanupTestData();
    await app.close();
  });

  it('POST /bookings/reservations deve criar reserva quando assentos disponíveis', async () => {
    // O booking-service não verifica JWT — o API Gateway faz isso e injeta
    // x-user-id / x-user-type como headers. No teste E2E direto ao serviço,
    // forjamos esses headers para simular o gateway.
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
    // expiresAt deve ser ~7 minutos (420s) no futuro
    expect(new Date(response.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(response.body).toHaveProperty('items');
  });

  it('POST /bookings/reservations deve retornar 409 quando assento já reservado', async () => {
    const seatId = 'existing-locked-seat-id';

    // Primeira reserva — adquire o lock Redis via SETNX
    await request(app.getHttpServer())
      .post('/bookings/reservations')
      .set('x-user-id', 'buyer-1')
      .set('x-user-type', 'buyer')
      .send({
        eventId: testEventId,
        items: [{ ticketBatchId: testBatchId, seatId, quantity: 1 }],
      });

    // Segunda reserva do mesmo assento por outro buyer — Redis SETNX retorna false
    const response = await request(app.getHttpServer())
      .post('/bookings/reservations')
      .set('x-user-id', 'buyer-2')
      .set('x-user-type', 'buyer')
      .send({
        eventId: testEventId,
        items: [{ ticketBatchId: testBatchId, seatId, quantity: 1 }],
      });

    expect(response.status).toBe(409);
    expect(response.body).toHaveProperty('message');
    expect(response.body).toHaveProperty('unavailableSeatIds');
    expect(response.body.unavailableSeatIds).toContain(seatId);
  });

  async function setupTestData(): Promise<void> {
    // Criar dados mínimos para os testes
    // (em projetos maiores: usar factories com faker)
  }

  async function cleanupTestData(): Promise<void> {
    await prisma.reservation.deleteMany({ where: { eventId: testEventId } });
  }
});
```

---

## Passo 14.3 — Teste de Concorrência (o mais importante)

Este é o teste que **prova** que o sistema resolve o problema central do ShowPass:
300.000 pessoas tentando o mesmo assento ao mesmo tempo. Apenas 1 deve vencer.

> **ATENÇÃO — Redis real obrigatório:** ao contrário do Passo 14.1 (que mocka o Redis),
> este teste sobe o `AppModule` completo com Redis e Postgres reais via `.env.test`.
> O objetivo é testar a atomicidade do `SETNX` — isso só pode ser provado com Redis de verdade.
> Rode `docker compose up -d` antes de executar este spec.

```typescript
// apps/booking-service/test/e2e/concurrency.e2e-spec.ts
//
// Sobe o AppModule completo — Redis + Postgres reais obrigatórios.
// PORQUÊ: SETNX é atômico no Redis, mas isso precisa ser validado em runtime,
// não em mocks. Mocks retornam o que você programa; o Redis real prova a garantia.

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';  // default import — NodeNext/ESM
import { AppModule } from '../../src/app.module.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';

describe('Concorrência: Double Booking Prevention', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const testEventId = 'concurrency-test-event-id';
  const testBatchId = 'concurrency-test-batch-id';

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = module.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await prisma.reservation.deleteMany({ where: { eventId: testEventId } });
    await app.close();
  });

  it('deve permitir apenas 1 reserva quando 50 buyers tentam o mesmo assento', async () => {
    const sharedSeatId = 'concurrency-test-seat-id';
    const buyerIds = Array.from({ length: 50 }, (_, i) => `concurrent-buyer-${i}`);

    // Promise.allSettled garante que esperamos TODOS terminarem,
    // mesmo que a maioria falhe com 409.
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

    // PORQUÊ exatamente 1: SETNX é atômico — apenas uma operação
    // pode setar a chave quando ela não existe. As outras 49 recebem false.
    expect(successful).toHaveLength(1);
    expect(failed).toHaveLength(49);

    // Dupla verificação no banco: apenas 1 reserva 'pending' para o evento
    const reservationsInDb = await prisma.reservation.count({
      where: { eventId: testEventId, status: 'pending' },
    });
    expect(reservationsInDb).toBe(1);
  }, 30_000);  // timeout de 30s — 50 requests simultâneas podem demorar
});
```

Se você ver `2 compradores adquiriram o lock` — há um bug de race condition.
Com Redis SETNX, isso **nunca deve acontecer**. Se acontecer, verifique se o Redis
está realmente subindo antes do teste (não mockado) e se a chave de lock está sendo
construída corretamente com `eventId + seatId`.

---

## Passo 14.4 — Playwright E2E

```typescript
// apps/web/e2e/checkout-flow.spec.ts
//
// Playwright testa o fluxo completo no browser (Chromium headless).
// Requer todos os serviços rodando: auth, event, booking, api-gateway, web.

import { test, expect } from '@playwright/test';

test.describe('Checkout Flow', () => {
  test('comprador consegue reservar assento e iniciar checkout', async ({ page }) => {
    // A página de login unificada é /login (criada no Cap 10).
    // Por baixo ela chama /auth/buyers/login ou /auth/organizers/login
    // dependendo do tipo de conta.
    await page.goto('/login');
    await page.fill('[data-testid="email"]', 'buyer@test.com');
    await page.fill('[data-testid="password"]', 'Test1234!');
    await page.click('[data-testid="submit"]');
    await expect(page).toHaveURL('/');

    // Navegar para um evento de teste
    await page.goto('/events/show-teste');
    await expect(page.locator('h1')).toContainText('Show Teste');

    // Selecionar assento disponível
    const availableSeat = page.locator('[aria-label*="Disponível"]').first();
    await availableSeat.click();
    await expect(availableSeat).toHaveAttribute('aria-pressed', 'true');

    // Clicar em Reservar
    await page.click('[data-testid="reserve-button"]');

    // Deve redirecionar para /checkout?reservation=<id> (querystring, não path param)
    await expect(page).toHaveURL(/\/checkout\?reservation=/);
    await expect(page.locator('[data-testid="reservation-timer"]')).toBeVisible();

    // O timer começa em 07:00 e conta regressivamente (TTL = 420s = 7 minutos).
    // O regex casa qualquer valor entre 00:00 e 06:59 — se aparecer 07:xx
    // o teste acabou de entrar na página e o timer ainda não decrementou,
    // então permitimos 07:00 também via /0[0-7]:[0-5][0-9]/.
    // PORQUÊ não 14:xx: a reserva expira em 7 min, não 15.
    const timerText = await page.locator('[data-testid="reservation-timer"]').textContent();
    expect(timerText).toMatch(/0[0-7]:[0-5][0-9]/);
  });
});
```

---

## Passo 14.5 — k6 Load Test

O arquivo k6 é **JavaScript puro** — roda no runtime Goja (Go), não em Node.js.
Anotações de tipo TypeScript como `: void` causam erro de parse. Use JS sem tipos.

```javascript
// infra/k6/seat-reservation.js
//
// Simula 1000 usuários tentando reservar ingressos simultaneamente.
// Mede: taxa de sucesso, latência P95/P99, throughput.
//
// PORQUÊ apontamos para :3004 e não :3000 (API Gateway):
// O gateway na porta 3000 exige JWT real no Authorization header.
// Em load test forjamos x-user-id diretamente — o gateway bloquearia isso.
// Em produção NUNCA exponha o booking-service diretamente; aqui é só para teste de carga.

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

// Aponta direto ao booking-service (:3004), não ao gateway (:3000).
// Veja o comentário no topo do arquivo.
const BASE_URL = __ENV.BASE_URL ?? 'http://localhost:3004';

export default function () {
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

  // 201 = sucesso, 409 = assento indisponível (esperado em alta concorrência — não é erro)
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
# Executar o load test apontando direto ao booking-service
k6 run --env EVENT_ID=xxx --env BATCH_ID=yyy infra/k6/seat-reservation.js

# Resultado esperado:
# ✓ resposta esperada (201 ou 409): 99.8%
# ✓ latência < 500ms: 96.2%
# http_req_duration p(95)=287ms p(99)=412ms
```

---

## Testando na prática

Este capítulo é sobre executar os testes. Você vai rodar cada suite e interpretar os resultados.

### Pré-requisitos

```bash
# Redis + Postgres reais para os testes de integração e concorrência (14.2 e 14.3)
# Testes unitários (14.1) NÃO precisam de Docker — Redis é mockado
docker compose up -d
pnpm install
pnpm turbo run db:generate   # gerar clients Prisma
```

### Passo a passo

**1. Rodar todos os testes**

```bash
pnpm turbo run test
```

O Turborepo executa em paralelo. Saída esperada:

```
booking-service:test: Tests: 23 passed, 0 failed
auth-service:test:   Tests: 14 passed, 0 failed
event-service:test:  Tests: 18 passed, 0 failed
```

**2. Rodar apenas testes unitários do SeatLockService**

Sem Docker — Redis é mockado neste spec. Pode rodar em qualquer máquina sem infraestrutura.

```bash
pnpm --filter @showpass/booking-service run test -- --testPathPattern="seat-lock"
```

Saída esperada:

```
PASS src/modules/locks/seat-lock.service.spec.ts
  SeatLockService
    acquireMultiple
      ✓ deve adquirir todos os locks e retornar success: true (5ms)
      ✓ deve liberar locks adquiridos quando um falha (compensação all-or-nothing) (3ms)
      ✓ deve retornar todos os seatIds indisponíveis quando múltiplos falham (4ms)
```

**3. Rodar o teste de concorrência (o mais importante)**

> **Requer Docker rodando** (`docker compose up -d`) — Redis real é obrigatório para provar SETNX.

```bash
pnpm --filter @showpass/booking-service run test -- --testPathPattern="concurrency"
```

Este teste dispara 50 compradores simultâneos para o mesmo assento:

```
PASS test/e2e/concurrency.e2e-spec.ts
  Concorrência: Double Booking Prevention
    ✓ deve permitir apenas 1 reserva quando 50 buyers tentam o mesmo assento (1843ms)
```

Se você ver que `2 compradores adquiriram o lock` — há um bug de race condition.
Nunca deve acontecer com Redis SETNX. Verifique se o Redis está realmente ativo
(não mockado) e se a chave de lock inclui `eventId + seatId`.

**4. Rodar testes E2E com Playwright**

```bash
# Precisa dos serviços rodando
pnpm --filter @showpass/auth-service run dev &
pnpm --filter @showpass/event-service run dev &
pnpm --filter @showpass/booking-service run dev &
pnpm --filter @showpass/api-gateway run dev &
pnpm --filter @showpass/web run dev &

# Rodar Playwright
pnpm --filter @showpass/web run test:e2e
```

O browser Chromium abre, navega para `/login`, faz login automaticamente, seleciona
assentos e verifica o redirect para `/checkout?reservation=<id>`. Para ver o browser:

```bash
pnpm --filter @showpass/web run test:e2e -- --headed
```

**5. Rodar o load test com k6**

```bash
# Instalar k6 (se necessário)
# macOS: brew install k6
# Linux: sudo apt-get install k6

# Subir o booking-service diretamente na :3004
# (load test aponta para :3004, não para o gateway :3000)
pnpm --filter @showpass/booking-service run dev &

k6 run --env EVENT_ID=xxx --env BATCH_ID=yyy infra/k6/seat-reservation.js
```

Saída esperada ao final:

```
✓ resposta esperada (201 ou 409)    99.8%
✓ latência < 500ms                  96.2%

http_reqs: 10000
http_req_duration p(95)=287ms p(99)=412ms
```

Se P95 > 500ms com apenas 1000 usuários, há um gargalo a investigar — normalmente
no pool de conexões do Prisma ou no pipeline de comandos do Redis.

**6. Ver cobertura de testes**

```bash
pnpm --filter @showpass/booking-service run test -- --coverage
```

Abra `apps/booking-service/coverage/index.html` no browser para ver quais linhas
não têm cobertura. Foque em cobrir o `SeatLockService` e os casos de erro do
`ReservationsService`.

---

## Recapitulando

1. **Jest unit tests** — mockar infraestrutura (Redis, Prisma); testar lógica de compensação isolada; roda sem Docker
2. **Supertest E2E** — testar controllers com banco e Redis reais; detectar bugs de integração; NÃO registrar `ValidationPipe` global (o projeto usa `ZodValidationPipe` por rota)
3. **Concurrency test** — 50 buyers no mesmo assento com Redis real; provar que SETNX garante exatamente 1 sucesso
4. **Playwright** — testar fluxo completo no browser; login em `/login`; redirect para `/checkout?reservation=<id>`; timer de 7 minutos
5. **k6 load test** — validar que o sistema aguenta 1000 usuários simultâneos com P95 < 500ms; apontar para `:3004` (booking-service direto), não para o gateway `:3000`

---

## Próximo capítulo

[Capítulo 15 → CI/CD](cap-15-cicd.md)
