// apps/booking-service/src/main.ts
// Ponto de entrada do Booking Service — implementado no Capítulo 6.
// Núcleo do sistema anti-double-booking via Redis SETNX atômico.
// ATENÇÃO: ver apps/booking-service/CLAUDE.md antes de qualquer alteração.

import 'dotenv/config';
// Instrumentação OpenTelemetry — DEPOIS do dotenv (precisa de OTEL_* no env),
// ANTES de qualquer import do Nest/http para a auto-instrumentação patchear cedo.
import './instrumentation.js';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Transport } from '@nestjs/microservices';
import type { MicroserviceOptions } from '@nestjs/microservices';
import { AppModule } from './app.module.js';
import { Logger } from '@nestjs/common';
import { OtelLogger } from './common/logging/otel-logger.service.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  // Substituir o logger padrão pelo OtelLogger: mantém o console e envia cada
  // log como OTLP → Collector → Loki. bufferLogs garante que os logs de
  // bootstrap também passem por ele.
  app.useLogger(new OtelLogger());

  // ─── Kafka consumer (hybrid app) ────────────────────────────────────────────
  // Além de servir HTTP, o booking-service consome eventos do event-service
  // para manter a réplica local de TicketBatch atualizada.
  // connectMicroservice + startAllMicroservices ativa os @EventPattern.
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.KAFKA,
    options: {
      client: {
        clientId: process.env['KAFKA_CLIENT_ID'] ?? 'booking-service',
        brokers: (process.env['KAFKA_BROKERS'] ?? 'localhost:29092').split(','),
      },
      consumer: {
        // groupId separado do producer — cada consumer group recebe sua cópia
        // dos eventos. Se tivéssemos 2 réplicas, ambas receberiam (cada uma
        // processando uma partição diferente, load-balanceado pelo Kafka).
        groupId: process.env['KAFKA_CONSUMER_GROUP_ID'] ?? 'booking-service-consumer',
        allowAutoTopicCreation: false,
      },
    },
  });

  await app.startAllMicroservices();

  const port = parseInt(process.env['PORT'] ?? '3004', 10);
  await app.listen(port);
  Logger.log(`Booking Service rodando na porta ${String(port)}`);
  Logger.log('Kafka consumer ativo (events.ticket-batch-*)');
}

void bootstrap();
