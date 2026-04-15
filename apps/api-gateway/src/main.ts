// apps/api-gateway/src/main.ts
// Ponto de entrada do API Gateway.
// Configura Helmet (OWASP A05), CORS, filtros globais e Swagger (dev only).

import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import helmet from 'helmet';
import { Logger } from '@nestjs/common';
import { HttpExceptionFilter } from './common/filters/http-exception.filter.js';
import { RequestIdInterceptor } from './common/interceptors/request-id.interceptor.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    // Desabilitar logs do NestJS em produção (usar OpenTelemetry)
    logger:
      process.env['NODE_ENV'] === 'production'
        ? ['error', 'warn']
        : ['log', 'debug', 'error', 'warn'],
  });

  // ─── OWASP A05: Security Headers via Helmet ─────────────────────────────────
  app.use(
    helmet({
      // Content Security Policy: bloqueia recursos não autorizados
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"], // UI libs exigem isso
          imgSrc: ["'self'", 'data:', 'https:'],
          connectSrc: ["'self'"],
          frameSrc: ["'none'"],
          objectSrc: ["'none'"],
        },
      },
      // HSTS: força HTTPS por 1 ano
      hsts: {
        maxAge: 31_536_000,
        includeSubDomains: true,
        preload: true,
      },
      // Esconde a tecnologia usada (OWASP A05)
      hidePoweredBy: true,
      // Previne clickjacking
      frameguard: { action: 'deny' },
      // Previne MIME sniffing
      noSniff: true,
    }),
  );

  // ─── CORS: apenas origens permitidas ─────────────────────────────────────────
  app.enableCors({
    origin: process.env['ALLOWED_ORIGINS']?.split(',') ?? ['http://localhost:3000'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-request-id'],
    credentials: true,
    maxAge: 86_400, // cache preflight por 24h
  });

  // ─── Filters e Interceptors globais ──────────────────────────────────────────
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new RequestIdInterceptor());

  // ─── Swagger (apenas em dev/staging) ─────────────────────────────────────────
  if (process.env['NODE_ENV'] !== 'production') {
    const { DocumentBuilder, SwaggerModule } = await import('@nestjs/swagger');
    const config = new DocumentBuilder()
      .setTitle('ShowPass API')
      .setDescription('Plataforma de venda de ingressos')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('docs', app, document);
    Logger.log('Swagger disponível em http://localhost:3000/docs');
  }

  const port = process.env['PORT'] ?? 3000;
  await app.listen(port);
  Logger.log(`API Gateway rodando na porta ${port.toString()}`);
}

void bootstrap();
