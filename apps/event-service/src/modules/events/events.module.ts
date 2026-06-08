// apps/event-service/src/modules/events/events.module.ts

import { Module } from '@nestjs/common';
import { EventsController } from './events.controller.js';
import { EventsService } from './events.service.js';
import { EventsRepository } from './events.repository.js';
import { EventGrpcController } from './event-grpc.controller.js';

@Module({
  // EventGrpcController registrado junto ao EventsController HTTP.
  // NestJS distingue o transporte por decorators: @Get/@Post vs @GrpcMethod.
  controllers: [EventsController, EventGrpcController],
  // PrismaService não listado aqui — fornecido pelo PrismaModule global
  providers: [EventsService, EventsRepository],
  exports: [EventsRepository],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- padrão NestJS
export class EventsModule {}
