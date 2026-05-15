// apps/booking-service/src/modules/events/events.module.ts
//
// Só o consumer vive aqui — queries sobre Event acontecem direto no
// ReservationsController via `this.prisma.event.*`. Mesmo padrão do
// TicketBatchesModule.

import { Module } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { EventsConsumer } from './events.consumer.js';

@Module({
  // NestJS + microservices roteia @EventPattern a partir de controllers.
  controllers: [EventsConsumer],
  providers: [PrismaService],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- padrão NestJS
export class EventsModule {}
