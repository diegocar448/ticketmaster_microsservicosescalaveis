// apps/booking-service/src/modules/health/health.controller.ts
//
// Liveness vs Readiness (cap-16):
//   - /health/live  → "o processo está vivo?" (resposta imediata, sem checar deps).
//                     Se falhar, o K8s REINICIA o pod.
//   - /health/ready → "consigo atender tráfego?" (checa Redis + Postgres).
//                     Se falhar, o K8s REMOVE o pod do Service (sem reiniciar) —
//                     evita mandar request para um pod que ainda não conectou.
//
// Não usamos @nestjs/terminus aqui: o booking-service já injeta RedisService
// (global) e PrismaService. Uma checagem direta é mais leve e sem nova dep.

import {
  Controller,
  Get,
  ServiceUnavailableException,
  Logger,
} from '@nestjs/common';
import { RedisService } from '@showpass/redis';
import { PrismaService } from '../../prisma/prisma.service.js';

@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('live')
  liveness(): { status: string; service: string } {
    return { status: 'ok', service: 'booking-service' };
  }

  /**
   * Readiness — checa as dependências críticas em paralelo:
   *   - Postgres: SELECT 1 (prova que o pool tem conexão)
   *   - Redis: GET de uma chave sentinela (prova autenticação + conectividade)
   * Qualquer falha → 503, e o K8s tira o pod do balanceamento.
   *
   * Timeout explícito: o ioredis ENFILEIRA comandos quando o servidor está
   * inacessível (em vez de falhar na hora). Sem o timeout, o endpoint TRAVARIA
   * segurando a conexão HTTP — o readinessProbe deve falhar RÁPIDO.
   */
  @Get('ready')
  async readiness(): Promise<{
    status: string;
    checks: { postgres: string; redis: string };
  }> {
    try {
      await this.withTimeout(
        Promise.all([
          this.prisma.$queryRaw`SELECT 1`,
          this.redis.getRaw('health:ready'),
        ]),
        2_000,
      );
      return {
        status: 'ok',
        checks: { postgres: 'up', redis: 'up' },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Readiness falhou: ${message}`);
      throw new ServiceUnavailableException({
        status: 'error',
        message: 'Dependências indisponíveis',
      });
    }
  }

  // Promise.race contra um timer — rejeita se as deps não responderem a tempo.
  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => {
          reject(new Error(`Health check timeout (${String(ms)}ms)`));
        }, ms),
      ),
    ]);
  }
}
