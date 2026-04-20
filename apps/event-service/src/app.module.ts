// apps/event-service/src/app.module.ts
//
// Módulo raiz do Event Service.
// Configura infraestrutura (Redis, Kafka, Prisma) e importa feature modules.

import { Module } from '@nestjs/common';
import { KafkaModule } from '@showpass/kafka';
import { RedisModule } from '@showpass/redis';
import { PrismaModule } from './prisma/prisma.module.js';
import { EventsModule } from './modules/events/events.module.js';
import { VenuesModule } from './modules/venues/venues.module.js';
import { CategoriesModule } from './modules/categories/categories.module.js';
import { TicketBatchesModule } from './modules/ticket-batches/ticket-batches.module.js';
import { OrganizersModule } from './modules/organizers/organizers.module.js';
import { HealthModule } from './modules/health/health.module.js';

@Module({
  imports: [
    // Redis — cache-aside para leituras de eventos (TTL por status)
    RedisModule.forRoot({
      host: process.env['REDIS_HOST'] ?? 'localhost',
      port: Number(process.env['REDIS_PORT'] ?? '6379'),
      // Spread condicional para satisfazer exactOptionalPropertyTypes
      // (password?: string não aceita string | undefined explícito)
      ...(process.env['REDIS_PASSWORD'] !== undefined
        ? { password: process.env['REDIS_PASSWORD'] }
        : {}),
    }),

    // Kafka — emissão de eventos de domínio (EVENT_PUBLISHED, EVENT_CANCELLED)
    KafkaModule.forRoot({
      clientId: process.env['KAFKA_CLIENT_ID'] ?? 'event-service',
      brokers: (process.env['KAFKA_BROKERS'] ?? 'localhost:9092').split(','),
      groupId: process.env['KAFKA_GROUP_ID'] ?? 'event-service-group',
    }),

    // Prisma global — PrismaService disponível em todos os feature modules
    PrismaModule,

    HealthModule,
    EventsModule,
    VenuesModule,
    CategoriesModule,
    TicketBatchesModule,
    // Consumer de auth.organizer-* — replica organizers do auth-service.
    // Ver apps/event-service/src/modules/organizers/organizers.consumer.ts.
    OrganizersModule,
  ],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- padrão NestJS
export class AppModule {}
