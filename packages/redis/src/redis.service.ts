// Abstração sobre o ioredis com métodos utilitários para o ShowPass.
// Inclui suporte a Lua scripts (necessário para operações atômicas).

import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from './redis.module';

@Injectable()
export class RedisService {
  constructor(
    @Inject(REDIS_CLIENT)
    private readonly redis: Redis,
  ) {}

  // ─── Lock distribuído ──────────────────────────────────────────────────────

  /**
   * Tenta adquirir um lock exclusivo.
   *
   * SET key value NX EX ttl
   *
   * NX = "set only if Not eXists" — operação atômica, sem race condition
   * EX = TTL em segundos — lock expira automaticamente (sem deadlock)
   *
   * @returns true se adquiriu o lock, false se já está travado
   */
  async acquireLock(key: string, ownerId: string, ttlSeconds: number): Promise<boolean> {
    // ioredis v5: ordem obrigatória EX <ttl> NX — não inverter (causa TS2769)
    const result = await this.redis.set(key, ownerId, 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  }

  /**
   * Libera o lock APENAS se for o dono (ownerId corresponde ao valor).
   *
   * Usa Lua script para garantir atomicidade: o GET e o DEL acontecem
   * na mesma operação — sem race condition entre verificar e deletar.
   */
  async releaseLock(key: string, ownerId: string): Promise<boolean> {
    const luaScript = `
      -- Verificar se o lock pertence ao dono antes de deletar
      if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("DEL", KEYS[1])
      else
        return 0
      end
    `;

    const result = await this.redis.eval(luaScript, 1, key, ownerId) as number;
    return result === 1;
  }

  /**
   * Renova o TTL de um lock existente.
   * Usado quando o checkout demora mais que o esperado.
   */
  async renewLock(key: string, ownerId: string, ttlSeconds: number): Promise<boolean> {
    const luaScript = `
      if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("EXPIRE", KEYS[1], ARGV[2])
      else
        return 0
      end
    `;

    const result = await this.redis.eval(luaScript, 1, key, ownerId, ttlSeconds) as number;
    return result === 1;
  }

  // ─── Cache simples ─────────────────────────────────────────────────────────

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.redis.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- T garante type-safety no caller (set<Event>(key, event))
  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const serialized = JSON.stringify(value);
    if (ttlSeconds) {
      await this.redis.setex(key, ttlSeconds, serialized);
    } else {
      await this.redis.set(key, serialized);
    }
  }

  async del(key: string): Promise<void> {
    await this.redis.del(key);
  }

  // ─── Contadores atômicos ───────────────────────────────────────────────────

  /**
   * Decrementa um contador e retorna o novo valor.
   * Usado para controlar ingressos disponíveis por lote.
   */
  async decrementAvailable(key: string, by = 1): Promise<number> {
    return this.redis.decrby(key, by);
  }

  async incrementAvailable(key: string, by = 1): Promise<number> {
    return this.redis.incrby(key, by);
  }
}