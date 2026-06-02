// apps/booking-service/src/modules/health/health.module.ts

import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { PrismaService } from '../../prisma/prisma.service.js';

@Module({
  controllers: [HealthController],
  // PrismaService é provido por módulo (não global); o /health/ready o injeta.
  // RedisService vem do RedisModule.forRoot({ global: true }) no app.module.
  providers: [PrismaService],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- padrão NestJS
export class HealthModule {}
