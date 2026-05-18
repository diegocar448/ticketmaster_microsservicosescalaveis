// apps/search-service/src/main.ts
//
// Hybrid app (cap-08): HTTP para /search/* + microservice Kafka que consome
// events.event-* e mantém o índice "events" do Elasticsearch sincronizado.
// Mesmo padrão do payment-service (cap-07).

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
        clientId: process.env['KAFKA_CLIENT_ID'] ?? 'search-service',
        brokers: (process.env['KAFKA_BROKERS'] ?? 'localhost:29092').split(','),
      },
      consumer: {
        groupId:
          process.env['KAFKA_CONSUMER_GROUP_ID'] ?? 'search-service-consumer',
        allowAutoTopicCreation: false,
      },
    },
  });

  await app.startAllMicroservices();
  await app.listen(process.env['PORT'] ?? 3005);
}

void bootstrap();
