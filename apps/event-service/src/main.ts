// apps/event-service/src/main.ts
// Ponto de entrada do Event Service.
// Responsável por gerenciamento de eventos, venues e publicação via Kafka.

import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Transport } from '@nestjs/microservices';
import type { MicroserviceOptions } from '@nestjs/microservices';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  // ─── Kafka consumer (hybrid app) ────────────────────────────────────────────
  // Event-service é simultaneamente:
  //   - Producer (emite events.ticket-batch-* e events.event-*)
  //   - Consumer (auth.organizer-* → replica organizers do auth-service)
  // connectMicroservice + startAllMicroservices ativa os @EventPattern do
  // OrganizersConsumer. Ver apps/event-service/src/modules/organizers/.
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.KAFKA,
    options: {
      client: {
        clientId: process.env['KAFKA_CLIENT_ID'] ?? 'event-service',
        brokers: (process.env['KAFKA_BROKERS'] ?? 'localhost:29092').split(','),
      },
      consumer: {
        // groupId separado do producer (event-service-group) — cada consumer
        // group recebe sua cópia dos eventos. Escalar o event-service em N
        // réplicas distribui as partições entre elas.
        groupId:
          process.env['KAFKA_CONSUMER_GROUP_ID'] ?? 'event-service-consumer',
        allowAutoTopicCreation: false,
      },
    },
  });

  await app.startAllMicroservices();

  const port = parseInt(process.env['PORT'] ?? '3003', 10);
  await app.listen(port);
  Logger.log(`Event Service rodando na porta ${port}`);
  Logger.log('Kafka consumer ativo (auth.organizer-*)');
}

void bootstrap();
