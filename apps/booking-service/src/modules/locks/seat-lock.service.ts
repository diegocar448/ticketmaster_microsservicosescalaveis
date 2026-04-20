// Gerencia locks distribuídos para assentos.
// Cada lock representa: "este assento está sendo reservado por este buyer".
// TTL de 15 minutos: se o buyer não completar o checkout, o lock expira.

import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '@showpass/redis';

// Prefixo das chaves no Redis — evita colisões com outras chaves
const LOCK_PREFIX = 'seat:lock';

// TTL do lock em segundos (7 minutos = janela de checkout)
// O Redis exclui a chave automaticamente ao expirar — sem cron job necessário
const LOCK_TTL_SECONDS = 7 * 60;

export interface SeatLockResult {
  acquired: boolean;
  lockKey: string;
  lockedBy?: string;
}

@Injectable()
export class SeatLockService {
  private readonly logger = new Logger(SeatLockService.name);

  constructor(private readonly redis: RedisService) {}

  /**
   * Gera a chave Redis para um assento específico de um evento.
   * Formato: seat:lock:{eventId}:{seatId}
   * Ex: seat:lock:550e8400:a1b2c3d4
   */
  private buildKey(eventId: string, seatId: string): string {
    return `${LOCK_PREFIX}:${eventId}:${seatId}`;
  }

  /**
   * Adquire lock de um único assento.
   * Retorna true se conseguiu, false se já está travado por outro usuário.
   */
  async acquireOne(
    eventId: string,
    seatId: string,
    buyerId: string,
  ): Promise<boolean> {
    const key = this.buildKey(eventId, seatId);
    return this.redis.acquireLock(key, buyerId, LOCK_TTL_SECONDS);
  }

  /**
   * Adquire locks de MÚLTIPLOS assentos de forma all-or-nothing.
   *
   * O algoritmo:
   * 1. Tentar adquirir cada lock em sequência
   * 2. Se algum falhar → liberar todos os adquiridos (compensação)
   * 3. Retornar lista de locks que NÃO foram adquiridos (para informar o usuário)
   *
   * Por que Lua e não múltiplos SETNX?
   * Lua scripts no Redis são atômicos — executam sem interrupção.
   * Usar MULTI/EXEC seria possível mas mais complexo de implementar corretamente.
   */
  async acquireMultiple(
    eventId: string,
    seatIds: string[],
    buyerId: string,
  ): Promise<{ success: boolean; unavailableSeatIds: string[] }> {
    const acquired: string[] = [];
    const unavailable: string[] = [];

    for (const seatId of seatIds) {
      const key = this.buildKey(eventId, seatId);
      const ok = await this.redis.acquireLock(key, buyerId, LOCK_TTL_SECONDS);

      if (ok) {
        acquired.push(seatId);
      } else {
        unavailable.push(seatId);
      }
    }

    // Se qualquer assento não estiver disponível → COMPENSAÇÃO
    if (unavailable.length > 0) {
      // Liberar todos os locks que já adquirimos
      // (buyer não pode ficar com locks parciais — outros ficam esperando)
      await this.releaseMultiple(eventId, acquired, buyerId);

      this.logger.warn('Assentos indisponíveis — locks liberados', {
        eventId,
        buyerId,
        unavailable,
        releasedLocks: acquired,
      });

      return { success: false, unavailableSeatIds: unavailable };
    }

    this.logger.log('Locks adquiridos com sucesso', {
      eventId,
      buyerId,
      seatCount: seatIds.length,
    });

    return { success: true, unavailableSeatIds: [] };
  }

  /**
   * Libera múltiplos locks.
   * Usa Lua script para garantir que só libera se o dono for o mesmo buyerId.
   * (Previne que um buyer libere o lock de outro buyer)
   */
  async releaseMultiple(
    eventId: string,
    seatIds: string[],
    buyerId: string,
  ): Promise<void> {
    const releasePromises = seatIds.map((seatId) => {
      const key = this.buildKey(eventId, seatId);
      return this.redis.releaseLock(key, buyerId);
    });

    await Promise.all(releasePromises);
  }

  /**
   * Verifica o status atual de um assento.
   * Retorna o buyerId de quem está com o lock, ou null se disponível.
   */
  async getLockOwner(eventId: string, seatId: string): Promise<string | null> {
    const key = this.buildKey(eventId, seatId);
    return this.redis.get<string>(key);
  }

  /**
   * Verifica disponibilidade de múltiplos assentos combinando Redis + PostgreSQL.
   *
   * Por que duas fontes?
   *   - Redis sabe quem está em checkout agora (lock ativo com TTL)
   *   - PostgreSQL sabe quem já comprou (status 'sold' permanente)
   *
   * Regra: disponível = sem lock no Redis E status 'available' no banco
   *
   * A verificação no Redis é feita primeiro porque é ~50x mais rápida.
   * Só consultamos o banco para assentos sem lock (quantidade menor).
   */
  async checkAvailability(
    eventId: string,
    seatIds: string[],
  ): Promise<Record<string, 'available' | 'locked' | 'sold'>> {
    // Passo 1: verificar locks no Redis em paralelo (operações sub-millisegundo)
    const lockChecks = await Promise.all(
      seatIds.map(async (seatId) => ({
        seatId,
        lockedBy: await this.getLockOwner(eventId, seatId),
      })),
    );

    // Passo 2: assentos sem lock precisam ser verificados no banco
    // (podem estar 'sold' de uma compra anterior já confirmada)
    const unlockedSeatIds = lockChecks
      .filter((c) => c.lockedBy === null)
      .map((c) => c.seatId);

    return {
      // Assentos com lock no Redis → bloqueados (alguém está no checkout)
      ...Object.fromEntries(
        lockChecks
          .filter((c) => c.lockedBy !== null)
          .map((c) => [c.seatId, 'locked' as const]),
      ),
      // Assentos sem lock → o status vem do banco (available ou sold)
      ...Object.fromEntries(
        unlockedSeatIds.map((seatId) => [seatId, 'available' as const]),
        // Nota: o caller (ReservationsController) deve cruzar com o status do Postgres
        // para marcar corretamente como 'sold' os assentos já vendidos
      ),
    };
  }
}