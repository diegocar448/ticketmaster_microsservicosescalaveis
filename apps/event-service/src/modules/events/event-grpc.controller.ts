// apps/event-service/src/modules/events/event-grpc.controller.ts
//
// Servidor gRPC do event-service.
// Expõe o método GetEvent definido em packages/proto/event.proto.
//
// Por que um controller separado e não no EventsController HTTP?
// O transporte gRPC usa decorators diferentes (@GrpcMethod vs @Get/@Post).
// Manter separado evita misturar contextos HTTP e gRPC no mesmo controller,
// facilitando testes unitários isolados.

import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { EventsService } from './events.service.js';

interface GetEventRequest {
  eventId: string;
}

interface EventResponse {
  id: string;
  title: string;
  status: string;
  organizerId: string;
  maxTicketsPerOrder: number;
}

@Controller()
export class EventGrpcController {
  constructor(private readonly eventsService: EventsService) {}

  // Nome do serviço deve corresponder ao `service EventService {}` no .proto.
  // Nome do método corresponde ao `rpc GetEvent` (camelCase no NestJS).
  @GrpcMethod('EventService', 'GetEvent')
  async getEvent(data: GetEventRequest): Promise<EventResponse> {
    // Mesmo dado que GET /events/:id/public-meta retorna via HTTP,
    // agora via gRPC — zero lógica duplicada, mesma fonte de verdade.
    const event = await this.eventsService.getById(data.eventId);

    return {
      id:                  event.id,
      title:               event.title,
      status:              event.status,
      organizerId:         event.organizerId,
      maxTicketsPerOrder:  event.maxTicketsPerOrder,
    };
  }
}
