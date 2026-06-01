// apps/booking-service/src/modules/locks/seat-lock.service.spec.ts
//
// Teste unitário do SeatLockService.
//
// Redis é MOCKADO: o objetivo aqui é testar a lógica de compensação
// all-or-nothing (se um lock falha, os anteriores devem ser liberados).
// A atomicidade do SETNX Redis real é provada no concurrency.e2e-spec.ts.
//
// NodeNext/ESM: imports relativos DEVEM ter extensão .js mesmo em .ts
// (o compilador resolve para o .js em runtime). O moduleNameMapper do
// jest.config.js mapeia .js → .ts transparentemente.

import { Test } from '@nestjs/testing';
import { SeatLockService } from './seat-lock.service.js';
import { RedisService } from '@showpass/redis';

// Mock mínimo do RedisService — só os métodos que SeatLockService usa.
const mockRedis = {
  acquireLock: jest.fn(),
  releaseLock: jest.fn(),
  getRaw: jest.fn(),
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
      // A implementação tenta TODOS os assentos antes de compensar —
      // vantagem: informa todos os indisponíveis numa única resposta (melhor UX).
      // A compensação (releaseLock) acontece ao final, após coletar todos os falhos.
      mockRedis.acquireLock
        .mockResolvedValueOnce(true)   // seat-A: OK — adquirido
        .mockResolvedValueOnce(false)  // seat-B: FAIL — indisponível
        .mockResolvedValueOnce(true);  // seat-C: OK — adquirido (mas será liberado)

      mockRedis.releaseLock.mockResolvedValue(true);

      const result = await service.acquireMultiple(
        'event-123',
        ['seat-A', 'seat-B', 'seat-C'],
        'buyer-456',
      );

      expect(result.success).toBe(false);
      expect(result.unavailableSeatIds).toEqual(['seat-B']);

      // seat-A e seat-C foram adquiridos mas DEVEM ser liberados (compensação)
      expect(mockRedis.releaseLock).toHaveBeenCalledWith(
        expect.stringContaining('seat-A'),
        'buyer-456',
      );
      expect(mockRedis.releaseLock).toHaveBeenCalledWith(
        expect.stringContaining('seat-C'),
        'buyer-456',
      );

      // Todos os 3 assentos foram tentados (fail-fast não implementado — coleta todos)
      expect(mockRedis.acquireLock).toHaveBeenCalledTimes(3);
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
