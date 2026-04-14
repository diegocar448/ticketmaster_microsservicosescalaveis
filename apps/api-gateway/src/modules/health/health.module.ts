// apps/api-gateway/src/modules/health/health.module.ts
// Módulo de health check — liveness e readiness probes para Kubernetes.

import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HttpModule } from '@nestjs/axios';
import { HealthController } from './health.controller.js';

@Module({
  imports: [
    TerminusModule,
    HttpModule, // necessário para HttpHealthIndicator fazer HTTP pings
  ],
  controllers: [HealthController],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- padrão NestJS: módulo sem providers próprios
export class HealthModule {}
