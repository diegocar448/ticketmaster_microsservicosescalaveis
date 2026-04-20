// apps/event-service/src/modules/ticket-batches/ticket-batches.module.ts

import { Module } from '@nestjs/common';
import { TicketBatchesController } from './ticket-batches.controller.js';
import { TicketBatchesService } from './ticket-batches.service.js';
import { TicketBatchesRepository } from './ticket-batches.repository.js';

@Module({
  controllers: [TicketBatchesController],
  // PrismaService/RedisService/KafkaProducerService são globais (via forRoot)
  providers: [TicketBatchesService, TicketBatchesRepository],
  exports: [TicketBatchesRepository],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- padrão NestJS
export class TicketBatchesModule {}
