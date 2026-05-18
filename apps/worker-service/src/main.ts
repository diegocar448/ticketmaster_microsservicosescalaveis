// apps/worker-service/src/main.ts
//
// Worker Service — só consome Kafka (sem rotas HTTP públicas).
// /health fica exposto apenas para o liveness probe do K8s.

import 'dotenv/config';
import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { Transport } from '@nestjs/microservices';
import type { MicroserviceOptions } from '@nestjs/microservices';
import { AppModule } from './app.module.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.KAFKA,
    options: {
      client: {
        clientId: process.env['KAFKA_CLIENT_ID'] ?? 'worker-service',
        brokers: (process.env['KAFKA_BROKERS'] ?? 'localhost:29092').split(','),
      },
      consumer: {
        groupId:
          process.env['KAFKA_CONSUMER_GROUP_ID'] ?? 'worker-service-consumer',
        allowAutoTopicCreation: false,
      },
    },
  });

  await app.startAllMicroservices();
  await app.listen(process.env['PORT'] ?? 3007);
}

void bootstrap();
