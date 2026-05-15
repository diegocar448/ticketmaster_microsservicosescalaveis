import { Controller, Logger } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { KAFKA_TOPICS, BuyerReplicatedEventSchema } from '@showpass/types';
import { PrismaService } from '../../prisma/prisma.service.js';

@Controller()
export class BuyersConsumer {
  private readonly logger = new Logger(BuyersConsumer.name);

  constructor(private readonly prisma: PrismaService) {}

  @EventPattern(KAFKA_TOPICS.AUTH_BUYER_CREATED)
  async onCreated(@Payload() message: unknown): Promise<void> {
    const parsed = BuyerReplicatedEventSchema.safeParse(message);
    if (!parsed.success) {
      this.logger.warn('auth.buyer.created inválido', { issues: parsed.error.issues });
      return;
    }

    const { id, email, name } = parsed.data;

    // upsert é idempotente — retries do Kafka não quebram nada
    await this.prisma.buyer.upsert({
      where: { id },
      create: { id, email, name, lastSyncAt: new Date() },
      update: { email, name, lastSyncAt: new Date() },
    });
  }

  @EventPattern(KAFKA_TOPICS.AUTH_BUYER_UPDATED)
  async onUpdated(@Payload() message: unknown): Promise<void> {
    const parsed = BuyerReplicatedEventSchema.safeParse(message);
    if (!parsed.success) return;

    const { id, email, name } = parsed.data;
    await this.prisma.buyer.upsert({
      where: { id },
      create: { id, email, name, lastSyncAt: new Date() },
      update: { email, name, lastSyncAt: new Date() },
    });
  }
}