// apps/payment-service/src/modules/health/health.controller.ts
//
// Endpoint mínimo de liveness — batido pelo readiness do api-gateway
// e pelo K8s livenessProbe. Mesmo padrão de booking/event-service.

import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get('live')
  liveness(): { status: string; service: string } {
    return { status: 'ok', service: 'payment-service' };
  }
}
