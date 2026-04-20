// apps/event-service/src/modules/health/health.controller.ts
//
// Endpoint mínimo de liveness — batido pelo readiness do api-gateway
// e pelo K8s livenessProbe. Não precisa checar dependências aqui:
// o readiness do gateway já consolida a saúde de downstream.

import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get('live')
  liveness(): { status: string; service: string } {
    return { status: 'ok', service: 'event-service' };
  }
}
