// apps/booking-service/src/modules/events/events.module.ts
//
// Kafka consumer (eventos de replicação do event-service) + cliente gRPC.
//
// Por que gRPC no mesmo módulo que o consumer Kafka?
// Ambos se relacionam com o event-service: o consumer replica dados para uso
// offline (sem latência), o gRPC client faz chamadas síncronas em tempo real.
// Manter no mesmo módulo facilita localizar tudo relacionado a "event-service".

import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { join } from 'path';
import { PrismaService } from '../../prisma/prisma.service.js';
import { EventsConsumer } from './events.consumer.js';
import { EventGrpcClient, EVENT_GRPC_CLIENT } from './event-grpc.client.js';

@Module({
  imports: [
    // Registra o client gRPC que se conecta ao event-service na porta 50051.
    // Transport.GRPC usa HTTP/2 — uma conexão TCP para todas as chamadas paralelas.
    ClientsModule.register([
      {
        name: EVENT_GRPC_CLIENT,
        transport: Transport.GRPC,
        options: {
          url: process.env['EVENT_SERVICE_GRPC_URL'] ?? 'localhost:50051',
          package: 'showpass.events',
          protoPath: join(process.cwd(), '../../packages/proto/event.proto'),
        },
      },
    ]),
  ],
  controllers: [EventsConsumer],
  providers: [PrismaService, EventGrpcClient],
  exports: [EventGrpcClient],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- padrão NestJS
export class EventsModule {}
