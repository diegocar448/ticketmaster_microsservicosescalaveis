// apps/booking-service/src/modules/reservations/reservations.module.ts
//
// Módulo de reservas — agrega controller, service, job de expiração
// e as dependências externas (Redis via LocksModule, Kafka, Prisma).

import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service.js';
import { LocksModule } from '../locks/locks.module.js';
import { ReservationsController } from './reservations.controller.js';
import { ReservationsService } from './reservations.service.js';
import { ReservationExpirationJob } from './reservation-expiration.job.js';

// Redis e Kafka não são importados aqui — foram registrados como global
// no AppModule via forRoot(). Já estão disponíveis para injeção.
@Module({
  imports: [
    LocksModule,
    ScheduleModule.forRoot(),
  ],
  controllers: [ReservationsController],
  providers: [ReservationsService, ReservationExpirationJob, PrismaService],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- padrão NestJS
export class ReservationsModule {}
