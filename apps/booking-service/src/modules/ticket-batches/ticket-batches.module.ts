// apps/booking-service/src/modules/ticket-batches/ticket-batches.module.ts
//
// Este módulo só tem o consumer. Não há service/controller HTTP próprio —
// as queries sobre ticketBatch acontecem direto no ReservationsService
// via `this.prisma.ticketBatch.*`.

import { Module } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { TicketBatchesConsumer } from './ticket-batches.consumer.js';

@Module({
  // Consumer é registrado como controller — NestJS + microservices roteia
  // @EventPattern a partir de controllers.
  controllers: [TicketBatchesConsumer],
  providers: [PrismaService],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- padrão NestJS
export class TicketBatchesModule {}
