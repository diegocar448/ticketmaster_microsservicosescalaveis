// apps/event-service/src/main.ts
// Ponto de entrada do Event Service.
// Responsável por gerenciamento de eventos, venues e publicação via Kafka.

import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  const port = parseInt(process.env['PORT'] ?? '3003', 10);
  await app.listen(port);
}

void bootstrap();
