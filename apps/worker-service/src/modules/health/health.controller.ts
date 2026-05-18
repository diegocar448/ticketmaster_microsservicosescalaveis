// apps/worker-service/src/modules/health/health.controller.ts
//
// Liveness mínimo — batido pelo K8s livenessProbe.

import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get('live')
  liveness(): { status: string; service: string } {
    return { status: 'ok', service: 'worker-service' };
  }
}
