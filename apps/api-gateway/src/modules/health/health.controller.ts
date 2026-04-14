// apps/api-gateway/src/modules/health/health.controller.ts
//
// Endpoints de health check — usados pelo Kubernetes liveness/readiness probe.
// Kubernetes bate nestes endpoints para saber se o pod está saudável.

import { Controller, Get } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckResult,
  HealthCheckService,
  HealthIndicatorResult,
  HttpHealthIndicator,
} from '@nestjs/terminus';

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly http: HttpHealthIndicator,
  ) {}

  /**
   * Liveness probe: "o processo está vivo?"
   * Resposta simples — se chegou aqui, o processo está vivo.
   * Se falhar, Kubernetes reinicia o pod.
   */
  @Get('live')
  liveness(): { status: string } {
    return { status: 'ok' };
  }

  /**
   * Readiness probe: "o serviço está pronto para receber tráfego?"
   * Verifica se consegue alcançar os serviços downstream críticos.
   * Se falhar, Kubernetes remove o pod do load balancer (sem reiniciar).
   */
  @Get('ready')
  @HealthCheck()
  readiness(): Promise<HealthCheckResult> {
    return this.health.check([
      (): Promise<HealthIndicatorResult> =>
        this.http.pingCheck(
          'event-service',
          `${process.env['EVENT_SERVICE_URL'] ?? 'http://localhost:3002'}/health/live`,
        ),
      (): Promise<HealthIndicatorResult> =>
        this.http.pingCheck(
          'booking-service',
          `${process.env['BOOKING_SERVICE_URL'] ?? 'http://localhost:3003'}/health/live`,
        ),
    ]);
  }
}
