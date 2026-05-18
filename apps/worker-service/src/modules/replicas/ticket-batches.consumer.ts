// apps/worker-service/src/modules/replicas/ticket-batches.consumer.ts
//
// Réplica local mínima de TicketBatch (só id, eventId, name) — usada na
// descrição do ingresso ("Pista Premium"). Mesmo molde dos demais consumers.

import { Controller, Logger } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import {
  KAFKA_TOPICS,
  TicketBatchCreatedEventSchema,
  TicketBatchUpdatedEventSchema,
  TicketBatchDeletedEventSchema,
} from '@showpass/types';
import { PrismaService } from '../../prisma/prisma.service.js';

@Controller()
export class TicketBatchesConsumer {
  private readonly logger = new Logger(TicketBatchesConsumer.name);
  constructor(private readonly prisma: PrismaService) {}

  @EventPattern(KAFKA_TOPICS.TICKET_BATCH_CREATED)
  async onCreated(@Payload() raw: unknown): Promise<void> {
    const parsed = TicketBatchCreatedEventSchema.safeParse(raw);
    if (!parsed.success) {
      this.logger.warn('TICKET_BATCH_CREATED inválido', {
        issues: parsed.error.issues,
      });
      return;
    }
    const { id, eventId, name } = parsed.data;
    await this.prisma.ticketBatch.upsert({
      where: { id },
      create: { id, eventId, name, lastSyncAt: new Date() },
      update: { eventId, name, lastSyncAt: new Date() },
    });
  }

  @EventPattern(KAFKA_TOPICS.TICKET_BATCH_UPDATED)
  async onUpdated(@Payload() raw: unknown): Promise<void> {
    const parsed = TicketBatchUpdatedEventSchema.safeParse(raw);
    if (!parsed.success) {
      this.logger.warn('TICKET_BATCH_UPDATED inválido', {
        issues: parsed.error.issues,
      });
      return;
    }
    const { id, eventId, name } = parsed.data;
    await this.prisma.ticketBatch.upsert({
      where: { id },
      create: { id, eventId, name, lastSyncAt: new Date() },
      update: { eventId, name, lastSyncAt: new Date() },
    });
  }

  @EventPattern(KAFKA_TOPICS.TICKET_BATCH_DELETED)
  async onDeleted(@Payload() raw: unknown): Promise<void> {
    const parsed = TicketBatchDeletedEventSchema.safeParse(raw);
    if (!parsed.success) {
      this.logger.warn('TICKET_BATCH_DELETED inválido', {
        issues: parsed.error.issues,
      });
      return;
    }
    // deleteMany: idempotente (não lança se o registro já não existe)
    await this.prisma.ticketBatch.deleteMany({
      where: { id: parsed.data.id },
    });
  }
}
