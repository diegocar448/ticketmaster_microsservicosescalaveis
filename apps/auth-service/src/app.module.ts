// apps/auth-service/src/app.module.ts
//
// Módulo raiz do Auth Service.
// Rate limiting configurado em duas camadas:
//   - "default": 100 req/min para todos os endpoints
//   - "auth": 5 req/min para endpoints de login (OWASP A07)

import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { KafkaModule } from '@showpass/kafka';
import { AuthModule } from './modules/auth/auth.module.js';

@Module({
  imports: [
    // Rate limiting por IP — proteção contra brute force (OWASP A07)
    ThrottlerModule.forRoot([
      {
        name: 'default',
        ttl: 60_000,   // janela de 1 minuto
        limit: 100,    // máximo de requisições na janela
      },
      {
        name: 'auth',
        ttl: 60_000,
        limit: 5,      // login: máximo 5 tentativas/min
      },
    ]),

    // Kafka — auth publica eventos de organizer para replicação no event-service.
    // Só dados não-sensíveis trafegam: NUNCA passwordHash, role ou emailVerifiedAt.
    // Ver packages/types/kafka-topics.ts (AUTH_ORGANIZER_CREATED/UPDATED) e
    // apps/auth-service/CLAUDE.md "Responsabilidade única".
    KafkaModule.forRoot({
      clientId: process.env['KAFKA_CLIENT_ID'] ?? 'auth-service',
      brokers: (process.env['KAFKA_BROKERS'] ?? 'localhost:29092').split(','),
      groupId: process.env['KAFKA_GROUP_ID'] ?? 'auth-service-group',
    }),

    AuthModule,
  ],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- padrão NestJS
export class AppModule {}
