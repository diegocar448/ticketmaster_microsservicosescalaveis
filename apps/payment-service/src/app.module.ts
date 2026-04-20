// apps/payment-service/src/app.module.ts
//
// Módulo raiz do Payment Service.
//
// KafkaModule global — OrdersService e WebhooksController injetam o producer
// sem precisar reimportar o módulo.
//
// HealthModule ANTES dos demais — segue a mesma ordem que cap-03 do gateway.
// Não há ProxyController capturando '*' aqui, mas mantemos o padrão por
// consistência entre serviços (facilita leitura do tutorial).

import { Module } from '@nestjs/common';
import { KafkaModule } from '@showpass/kafka';

import { BuyersModule } from './modules/buyers/buyers.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { OrdersModule } from './modules/orders/orders.module.js';
import { OrganizersModule } from './modules/organizers/organizers.module.js';
import { WebhooksModule } from './modules/webhooks/webhooks.module.js';

@Module({
  imports: [
    KafkaModule.forRoot({
      clientId: process.env['KAFKA_CLIENT_ID'] ?? 'payment-service',
      brokers: (process.env['KAFKA_BROKERS'] ?? 'localhost:29092').split(','),
      groupId: process.env['KAFKA_GROUP_ID'] ?? 'payment-service-group',
    }),
    HealthModule,
    // Consumers Kafka: réplicas locais para evitar round-trip HTTP no checkout.
    BuyersModule,
    OrganizersModule,
    // HTTP: checkout + webhook.
    OrdersModule,
    WebhooksModule,
  ],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- padrão NestJS
export class AppModule {}
