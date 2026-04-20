// apps/booking-service/src/modules/buyers/buyers.consumer.ts
//
// Mantém a tabela `buyers` local em sincronia com o auth-service. Espelha a
// mesma ideia do OrganizersConsumer em event-service — ver kafka-topics.ts
// e apps/auth-service/CLAUDE.md "Responsabilidade única".
//
// Princípios (idênticos aos do organizer replication):
// 1. Só dados NÃO-sensíveis — passwordHash NUNCA chega aqui (OWASP A02).
// 2. Idempotência via upsert — Kafka re-entrega em caso de crash+restart.
// 3. Consumer não relança erro: payload inválido → log + skip (evita nack
//    infinito bloqueando a partição). Em prod: DLQ.

import { Controller, Logger } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  KAFKA_TOPICS,
  BuyerReplicatedEventSchema,
} from '@showpass/types';

@Controller()
export class BuyersConsumer {
  private readonly logger = new Logger(BuyersConsumer.name);

  constructor(private readonly prisma: PrismaService) {}

  @EventPattern(KAFKA_TOPICS.AUTH_BUYER_CREATED)
  async onCreated(@Payload() rawPayload: unknown): Promise<void> {
    await this.upsertBuyer(rawPayload, 'AUTH_BUYER_CREATED');
  }

  @EventPattern(KAFKA_TOPICS.AUTH_BUYER_UPDATED)
  async onUpdated(@Payload() rawPayload: unknown): Promise<void> {
    await this.upsertBuyer(rawPayload, 'AUTH_BUYER_UPDATED');
  }

  private async upsertBuyer(rawPayload: unknown, topic: string): Promise<void> {
    const parsed = BuyerReplicatedEventSchema.safeParse(rawPayload);
    if (!parsed.success) {
      this.logger.error(`Payload inválido em ${topic}`, { errors: parsed.error.issues });
      return;
    }

    const event = parsed.data;

    await this.prisma.buyer.upsert({
      where: { id: event.id },
      create: {
        id: event.id,
        email: event.email,
        name: event.name,
        lastSyncAt: new Date(),
      },
      update: {
        email: event.email,
        name: event.name,
        lastSyncAt: new Date(),
      },
    });

    this.logger.log(`Buyer replicado (${topic}): id=${event.id}, email=${event.email}`);
  }
}
