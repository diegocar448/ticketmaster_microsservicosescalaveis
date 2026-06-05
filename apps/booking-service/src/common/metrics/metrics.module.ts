// apps/booking-service/src/common/metrics/metrics.module.ts
//
// @Global: BusinessMetricsService fica disponível para injeção em qualquer
// módulo (ReservationsService) sem reimportar — mesmo padrão de Redis/Kafka.
import { Global, Module } from '@nestjs/common';
import { BusinessMetricsService } from './business-metrics.service.js';

@Global()
@Module({
  providers: [BusinessMetricsService],
  exports: [BusinessMetricsService],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- padrão NestJS
export class MetricsModule {}
