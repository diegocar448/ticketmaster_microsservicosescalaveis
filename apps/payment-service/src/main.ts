// apps/payment-service/src/main.ts
//
// Payment Service — integra Stripe Checkout, processa webhooks e emite
// eventos Kafka para o worker-service gerar ingressos.
//
// Hybrid app (HTTP + Kafka microservice) — mesmo padrão de booking/event
// (ver main.ts deles). Aqui precisamos de DOIS @EventPattern consumers
// (buyers + organizers) para manter réplicas locais; por isso startMicroservices.
//
// raw body no /webhooks/stripe: o Stripe assina o Buffer bruto. Se o Express
// parsear JSON antes, a assinatura HMAC não bate. Solução: body-parser raw
// montado ANTES da app NestJS inicializar os parsers globais.

import 'dotenv/config';
import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Transport } from '@nestjs/microservices';
import type { MicroserviceOptions } from '@nestjs/microservices';
import bodyParser from 'body-parser';

import { AppModule } from './app.module.js';

async function bootstrap(): Promise<void> {
  // rawBody: true faz o Nest preservar req.rawBody (Buffer) — usado pelo
  // WebhookController para validar HMAC sem ter o payload parseado.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });

  // Body parsers globais — o rawBody: true acima já preserva o Buffer
  // em req.rawBody; body-parser.json continua funcionando para rotas normais.
  app.use(bodyParser.json({ limit: '10mb' }));
  app.use(bodyParser.urlencoded({ extended: true }));

  // ─── Kafka consumer (hybrid app) ────────────────────────────────────────────
  // Consome auth.buyer-* e auth.organizer-* para manter réplicas locais
  // (ver BuyersConsumer e OrganizersConsumer).
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.KAFKA,
    options: {
      client: {
        clientId: process.env['KAFKA_CLIENT_ID'] ?? 'payment-service',
        brokers: (process.env['KAFKA_BROKERS'] ?? 'localhost:29092').split(','),
      },
      consumer: {
        groupId: process.env['KAFKA_CONSUMER_GROUP_ID'] ?? 'payment-service-consumer',
        allowAutoTopicCreation: false,
      },
    },
  });

  await app.startAllMicroservices();

  const port = parseInt(process.env['PORT'] ?? '3002', 10);
  await app.listen(port);
  Logger.log(`Payment Service rodando na porta ${port}`);
  Logger.log('Kafka consumer ativo (auth.buyer-*, auth.organizer-*)');
}

void bootstrap();
