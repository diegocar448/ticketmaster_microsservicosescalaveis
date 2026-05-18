// apps/worker-service/src/modules/replicas/buyers.consumer.ts
//
// Réplica local de Buyer (auth-service via Kafka). Existe para o e-mail
// (email + name) sem round-trip HTTP. Zod safe-parse + upsert idempotente.

import { Controller, Logger } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { KAFKA_TOPICS, BuyerReplicatedEventSchema } from '@showpass/types';
import { PrismaService } from '../../prisma/prisma.service.js';

@Controller()
export class BuyersConsumer {
  private readonly logger = new Logger(BuyersConsumer.name);
  constructor(private readonly prisma: PrismaService) {}

  @EventPattern(KAFKA_TOPICS.AUTH_BUYER_CREATED)
  async onCreated(@Payload() raw: unknown): Promise<void> {
    return this.upsert(raw, 'AUTH_BUYER_CREATED');
  }

  @EventPattern(KAFKA_TOPICS.AUTH_BUYER_UPDATED)
  async onUpdated(@Payload() raw: unknown): Promise<void> {
    return this.upsert(raw, 'AUTH_BUYER_UPDATED');
  }

  private async upsert(raw: unknown, topic: string): Promise<void> {
    const parsed = BuyerReplicatedEventSchema.safeParse(raw);
    if (!parsed.success) {
      this.logger.warn(`${topic} inválido`, { issues: parsed.error.issues });
      return;
    }
    const { id, email, name } = parsed.data;
    await this.prisma.buyer.upsert({
      where: { id },
      create: { id, email, name, lastSyncAt: new Date() },
      update: { email, name, lastSyncAt: new Date() },
    });
  }
}
