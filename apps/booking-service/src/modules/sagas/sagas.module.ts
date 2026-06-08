// apps/booking-service/src/modules/sagas/sagas.module.ts
//
// Módulo que registra os consumidores Kafka da saga de compra.
// LocksModule importado aqui para que BookingSaga possa injetar SeatLockService
// na compensação (payment.failed → liberar locks).

import { Module } from '@nestjs/common';
import { BookingSaga } from './booking.saga.js';
import { LocksModule } from '../locks/locks.module.js';
import { PrismaService } from '../../prisma/prisma.service.js';

@Module({
  imports: [LocksModule],
  // BookingSaga em controllers (não providers): o Kafka microservice transport
  // só roteia @EventPattern para classes registradas como controllers.
  // Mesmo padrão de BuyersConsumer, EventsConsumer, TicketBatchesConsumer.
  controllers: [BookingSaga],
  providers: [PrismaService],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- padrão NestJS
export class SagasModule {}
