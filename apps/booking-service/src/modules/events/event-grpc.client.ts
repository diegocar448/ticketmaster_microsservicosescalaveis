// apps/booking-service/src/modules/events/event-grpc.client.ts
//
// Cliente gRPC para o event-service.
//
// Por que gRPC em vez do fetch() HTTP existente?
// 1. Protobuf: payload ~5x menor que JSON → importa em pico de 300k req/s
// 2. HTTP/2: multiplexing sobre uma única conexão TCP — sem overhead de handshake por req
// 3. Contrato tipado: TypeScript inferido do proto → zero divergência entre serviços
// 4. Circuit Breaker embutido: se o event-service cair, fallback imediato
//
// Padrão NestJS 11: ClientsModule.register() + @Inject(token).
// @Client() decorator foi deprecated — usar injeção explícita via token.

import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import type { ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom, Observable } from 'rxjs';
import { createCircuitBreaker } from '@showpass/redis';
import type CircuitBreaker from 'opossum';

export const EVENT_GRPC_CLIENT = Symbol('EVENT_GRPC_CLIENT');

// Interface gerada do proto (manualmente — em prod usar `ts-proto` para gerar)
interface EventServiceGrpc {
  getEvent(data: { eventId: string }): Observable<{
    id: string;
    title: string;
    status: string;
    organizerId: string;
    maxTicketsPerOrder: number;
  }>;
}

export interface EventGrpcResponse {
  id: string;
  title: string;
  status: string;
  organizerId: string;
  maxTicketsPerOrder: number;
}

@Injectable()
export class EventGrpcClient implements OnModuleInit {
  private eventService!: EventServiceGrpc;
  // Circuit Breaker para chamadas gRPC ao event-service.
  // Se o event-service cair: rejeita reservas com 503 em vez de timeout de 30s.
  private readonly getEventBreaker: CircuitBreaker<[string], EventGrpcResponse>;

  constructor(@Inject(EVENT_GRPC_CLIENT) private readonly client: ClientGrpc) {
    this.getEventBreaker = createCircuitBreaker(
      (eventId: string) => this.callGetEvent(eventId),
      'grpc-event-service',
      { timeout: 3000, errorThresholdPercentage: 50, resetTimeout: 30_000 },
    );
  }

  onModuleInit(): void {
    this.eventService = this.client.getService<EventServiceGrpc>('EventService');
  }

  async getEvent(eventId: string): Promise<EventGrpcResponse> {
    return this.getEventBreaker.fire(eventId);
  }

  private async callGetEvent(eventId: string): Promise<EventGrpcResponse> {
    return firstValueFrom(this.eventService.getEvent({ eventId }));
  }
}
