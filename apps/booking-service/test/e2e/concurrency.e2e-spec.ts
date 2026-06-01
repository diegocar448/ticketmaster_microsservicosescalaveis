// apps/booking-service/test/e2e/concurrency.e2e-spec.ts
//
// ATENÇÃO — Redis real obrigatório: sobe o AppModule completo com Redis e
// Postgres reais via .env. O objetivo é testar a atomicidade do SETNX —
// isso só pode ser provado com Redis de verdade. Mocks retornam o que você
// programa; o Redis real prova a garantia.
//
// Rode `docker compose up -d` antes de executar este spec.

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';

const TEST_EVENT_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const TEST_BATCH_ID = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
const TEST_ORG_ID = 'c3d4e5f6-a7b8-9012-cdef-123456789012';
const TEST_BUYER_PREFIX = 'cccccccc-0000-4000-a000-';

function buyerId(idx: number): string {
  // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
  return `${TEST_BUYER_PREFIX}${String(idx).padStart(12, '0')}`;
}

describe('Concorrência: Double Booking Prevention', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = module.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);

    // Mockar global.fetch para interceptar o HTTP call de fetchEventData
    // (GET /events/:id/public-meta no event-service).
    // PORQUÊ global.fetch e não jest.spyOn no ReservationsService:
    //   - fetchEventData é um método PRIVADO — spyOn em privados é frágil
    //     (prototype e instância divergem no container de DI do NestJS).
    //   - global.fetch é a fronteira HTTP real: mockar aqui é mais robusto,
    //     independe de implementação interna e funciona em qualquer instância.
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: 'on_sale', organizerId: TEST_ORG_ID }),
    } as unknown as Response);

    await seedTestData(prisma);
  });

  afterAll(async () => {
    await cleanupTestData(prisma);
    await app.close();
  });

  it('deve permitir apenas 1 reserva quando 50 buyers tentam o mesmo assento', async () => {
    const sharedSeatId = 'dddddddd-0000-4000-a000-000000000001';
    const buyerCount = 50;
    const buyerIds = Array.from({ length: buyerCount }, (_, i) => buyerId(i));

    // Garantir que os buyers existem no banco (booking-service os replica do auth via Kafka,
    // mas aqui inserimos diretamente para o teste ser autossuficiente)
    await prisma.buyer.createMany({
      data: buyerIds.map((id) => ({ id, email: `${id}@test.com` })),
      skipDuplicates: true,
    });

    // Promise.allSettled: aguarda TODOS terminarem (maioria com 409)
    const results = await Promise.allSettled(
      buyerIds.map((bId) =>
        request(app.getHttpServer())
          .post('/bookings/reservations')
          .set('x-user-id', bId)
          .set('x-user-type', 'buyer')
          .send({
            eventId: TEST_EVENT_ID,
            items: [{ ticketBatchId: TEST_BATCH_ID, seatId: sharedSeatId, quantity: 1 }],
          }),
      ),
    );

    const successful = results.filter(
      (r) => r.status === 'fulfilled' && (r as PromiseFulfilledResult<{ status: number }>).value.status === 201,
    );
    const conflict = results.filter(
      (r) => r.status === 'fulfilled' && (r as PromiseFulfilledResult<{ status: number }>).value.status === 409,
    );

    // SETNX é atômico: exatamente 1 adquire o lock; os outros 49 recebem 409.
    expect(successful).toHaveLength(1);
    expect(conflict).toHaveLength(buyerCount - 1);

    // Dupla verificação no banco — só 1 reserva pending para este evento
    const count = await prisma.reservation.count({
      where: { eventId: TEST_EVENT_ID, status: 'pending' },
    });
    expect(count).toBe(1);
  }, 30_000); // 50 requests simultâneas podem demorar
});

async function seedTestData(prisma: PrismaService): Promise<void> {
  // Limpar dados anteriores (idempotente)
  await cleanupTestData(prisma);

  // Inserir Event replica (booking-service mantém réplica local).
  // Booking schema exige: slug único, status, startAt, endAt, venueCity, venueState.
  await prisma.event.upsert({
    where: { id: TEST_EVENT_ID },
    create: {
      id: TEST_EVENT_ID,
      organizerId: TEST_ORG_ID,
      title: 'Concurrency Test Event',
      slug: `concurrency-test-${TEST_EVENT_ID}`,
      status: 'on_sale',
      startAt: new Date(Date.now() + 86_400_000),
      endAt: new Date(Date.now() + 90_000_000),
      venueCity: 'São Paulo',
      venueState: 'SP',
      thumbnailUrl: null,
    },
    update: {},
  });

  // TicketBatch com capacidade suficiente para todos os 50 buyers tentarem
  await prisma.ticketBatch.upsert({
    where: { id: TEST_BATCH_ID },
    create: {
      id: TEST_BATCH_ID,
      eventId: TEST_EVENT_ID,
      name: 'Pista Concurrency',
      price: 100,
      totalQuantity: 100,
      soldCount: 0,
      reservedCount: 0,
      isVisible: true,
      saleStartAt: new Date(Date.now() - 3600_000),
      saleEndAt: new Date(Date.now() + 3600_000),
    },
    update: {},
  });
}

async function cleanupTestData(prisma: PrismaService): Promise<void> {
  await prisma.reservationItem.deleteMany({
    where: { reservation: { eventId: TEST_EVENT_ID } },
  });
  await prisma.reservation.deleteMany({ where: { eventId: TEST_EVENT_ID } });
  await prisma.ticketBatch.deleteMany({ where: { eventId: TEST_EVENT_ID } });
  await prisma.event.deleteMany({ where: { id: TEST_EVENT_ID } });
}
