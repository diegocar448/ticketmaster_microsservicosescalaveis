// apps/booking-service/src/modules/health/health.controller.ts
//
// Endpoint mínimo de liveness — batido pelo readiness do api-gateway
// e pelo K8s livenessProbe. Ver justificativa em event-service.

import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get('live')
  liveness(): { status: string; service: string } {
    return { status: 'ok', service: 'booking-service' };
  }
}
