// apps/payment-service/src/modules/health/health.module.ts

import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';

@Module({
  controllers: [HealthController],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- padrão NestJS
export class HealthModule {}
