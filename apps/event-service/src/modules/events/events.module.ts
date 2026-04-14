// apps/event-service/src/modules/events/events.module.ts

import { Module } from '@nestjs/common';
import { EventsController } from './events.controller.js';
import { EventsService } from './events.service.js';
import { EventsRepository } from './events.repository.js';

@Module({
  controllers: [EventsController],
  // PrismaService não listado aqui — fornecido pelo PrismaModule global
  providers: [EventsService, EventsRepository],
  exports: [EventsRepository],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- padrão NestJS
export class EventsModule {}
