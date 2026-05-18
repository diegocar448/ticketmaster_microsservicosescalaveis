// apps/search-service/src/modules/health/health.controller.ts
//
// Liveness mínimo — batido pelo readiness do api-gateway e pelo K8s
// livenessProbe. Mesmo padrão de payment/booking/event-service.

import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get('live')
  liveness(): { status: string; service: string } {
    return { status: 'ok', service: 'search-service' };
  }
}
