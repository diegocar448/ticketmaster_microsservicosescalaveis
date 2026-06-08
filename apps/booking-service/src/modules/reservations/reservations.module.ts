// apps/booking-service/src/modules/reservations/reservations.module.ts
//
// Módulo de reservas — agrega controller, service, job de expiração,
// CQRS (commands + queries) e as dependências externas (Redis, Kafka, Prisma).

import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service.js';
import { LocksModule } from '../locks/locks.module.js';
import { ReservationsController } from './reservations.controller.js';
import { ReservationsService } from './reservations.service.js';
import { ReservationExpirationJob } from './reservation-expiration.job.js';
import { CreateReservationHandler } from './handlers/create-reservation.handler.js';
import { GetBuyerReservationsHandler } from './queries/get-buyer-reservations.query.js';

const COMMAND_HANDLERS = [CreateReservationHandler];
const QUERY_HANDLERS   = [GetBuyerReservationsHandler];

// Redis e Kafka não são importados aqui — foram registrados como global
// no AppModule via forRoot(). Já estão disponíveis para injeção.
@Module({
  imports: [
    LocksModule,
    ScheduleModule.forRoot(),
    // CqrsModule registra CommandBus, QueryBus e EventBus como providers globais.
    // Necessário para que o CreateReservationHandler seja encontrado pelo CommandBus.
    CqrsModule,
  ],
  controllers: [ReservationsController],
  providers: [
    ReservationsService,
    ReservationExpirationJob,
    PrismaService,
    ...COMMAND_HANDLERS,
    ...QUERY_HANDLERS,
  ],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- padrão NestJS
export class ReservationsModule {}
