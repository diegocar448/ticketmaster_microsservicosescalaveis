// apps/worker-service/src/app.module.ts

import { Module } from '@nestjs/common';
import { KafkaModule } from '@showpass/kafka';

import { HealthModule } from './modules/health/health.module.js';
import { BuyersConsumer } from './modules/replicas/buyers.consumer.js';
import { EventsConsumer } from './modules/replicas/events.consumer.js';
import { TicketBatchesConsumer } from './modules/replicas/ticket-batches.consumer.js';
import { PaymentConfirmedConsumer } from './modules/tickets/payment-confirmed.consumer.js';
import { DlqAuditConsumer } from './modules/dlq/dlq-audit.consumer.js';
import { TicketGeneratorService } from './modules/tickets/ticket-generator.service.js';
import { PdfGeneratorService } from './modules/tickets/pdf-generator.service.js';
import { PdfStorageService } from './modules/tickets/pdf-storage.service.js';
import { EmailService } from './modules/email/email.service.js';
import { PrismaService } from './prisma/prisma.service.js';

@Module({
  imports: [
    KafkaModule.forRoot({
      clientId: process.env['KAFKA_CLIENT_ID'] ?? 'worker-service',
      brokers: (process.env['KAFKA_BROKERS'] ?? 'localhost:29092').split(','),
      groupId: process.env['KAFKA_GROUP_ID'] ?? 'worker-service-group',
    }),
    HealthModule,
  ],
  controllers: [
    BuyersConsumer,
    EventsConsumer,
    TicketBatchesConsumer,
    PaymentConfirmedConsumer,
    DlqAuditConsumer,
  ],
  providers: [
    PrismaService,
    TicketGeneratorService,
    PdfGeneratorService,
    PdfStorageService,
    EmailService,
  ],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- padrão NestJS
export class AppModule {}
