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

import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import bodyParser from 'body-parser';

import { AppModule } from './app.module.js';

async function bootstrap(): Promise<void> {
  // rawBody: true é CRÍTICO — habilita req.rawBody no controller do webhook.
  // Sem isso, o parser JSON consome o body e a validação HMAC falha
  // (o Stripe assina os bytes originais, não o JSON re-serializado).
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });

  // JSON parser global para as outras rotas. Como rawBody: true preserva o
  // buffer bruto via req.rawBody, podemos parsear normalmente aqui.
  app.use(bodyParser.json({ limit: '10mb' }));

  // ─── Kafka microservice (consumers) ───────────────────────────────────────
  // Conectamos o transport Kafka para que @EventPattern rode no mesmo processo.
  // Um groupId dedicado evita que o consumer "roube" mensagens do producer.
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
  await app.listen(process.env['PORT'] ?? 3002);
}

void bootstrap();