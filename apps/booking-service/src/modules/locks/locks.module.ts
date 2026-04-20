// apps/booking-service/src/modules/locks/locks.module.ts
//
// Módulo de locks distribuídos — exporta SeatLockService para ser
// injetado no ReservationsModule sem duplicar a instância do Redis.

import { Module } from '@nestjs/common';
import { SeatLockService } from './seat-lock.service.js';

// RedisModule não é importado aqui porque foi registrado como global
// no AppModule via RedisModule.forRoot() — já disponível para injeção.
@Module({
  providers: [SeatLockService],
  exports: [SeatLockService],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- padrão NestJS
export class LocksModule {}
