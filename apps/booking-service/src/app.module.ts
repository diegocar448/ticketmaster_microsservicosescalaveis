// apps/booking-service/src/app.module.ts
//
// Módulo raiz do Booking Service.
// RedisModule.forRoot() com global:true — disponível em todos os módulos filhos
// sem precisar reimportar. Padrão idêntico ao auth-service.

import { Module } from '@nestjs/common';
import { RedisModule } from '@showpass/redis';
import { KafkaModule } from '@showpass/kafka';
import { ReservationsModule } from './modules/reservations/reservations.module.js';
import { TicketBatchesModule } from './modules/ticket-batches/ticket-batches.module.js';
import { BuyersModule } from './modules/buyers/buyers.module.js';
import { HealthModule } from './modules/health/health.module.js';

@Module({
  imports: [
    // Redis global — SeatLockService injeta RedisService sem importar RedisModule novamente
    RedisModule.forRoot({
      host: process.env['REDIS_HOST'] ?? 'localhost',
      port: parseInt(process.env['REDIS_PORT'] ?? '6379', 10),
      password: process.env['REDIS_PASSWORD'],
    }),
    // Kafka global — ReservationsService injeta KafkaProducerService
    KafkaModule.forRoot({
      clientId: process.env['KAFKA_CLIENT_ID'] ?? 'booking-service',
      brokers: (process.env['KAFKA_BROKERS'] ?? 'localhost:29092').split(','),
      groupId: process.env['KAFKA_GROUP_ID'] ?? 'booking-service-group',
    }),
    HealthModule,
    ReservationsModule,
    // Consumer Kafka: mantém réplica local de TicketBatch atualizada
    TicketBatchesModule,
    // Consumer Kafka: replica buyer do auth-service para satisfazer FK
    // Reservation.buyerId. Dados sensíveis NUNCA trafegam (ver BuyersConsumer).
    BuyersModule,
  ],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- padrão NestJS
export class AppModule {}
