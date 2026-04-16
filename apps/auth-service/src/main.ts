// apps/auth-service/src/main.ts
// Ponto de entrada do Auth Service.
// Responsável por emissão de JWT RS256 e refresh token rotation.
// ATENÇÃO: ver apps/auth-service/CLAUDE.md antes de qualquer alteração.

import 'dotenv/config';   // deve ser o PRIMEIRO import — carrega .env antes de qualquer módulo
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import cookieParser from 'cookie-parser';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  // Cookie parser — necessário para ler httpOnly refresh token
  app.use(cookieParser());

  const port = parseInt(process.env['PORT'] ?? '3006', 10);
  await app.listen(port);
}

void bootstrap();
