// apps/worker-service/src/modules/replicas/events.consumer.ts
//
// Réplica local de Event (event-service via Kafka) — título + venue para o
// PDF/e-mail. Mesma estratégia do booking-service.

import { Controller, Logger } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { KAFKA_TOPICS, EventReplicatedEventSchema } from '@showpass/types';
import { PrismaService } from '../../prisma/prisma.service.js';

@Controller()
export class EventsConsumer {
  private readonly logger = new Logger(EventsConsumer.name);
  constructor(private readonly prisma: PrismaService) {}

  @EventPattern(KAFKA_TOPICS.EVENT_PUBLISHED)
  async onPublished(@Payload() raw: unknown): Promise<void> {
    return this.upsert(raw, 'EVENT_PUBLISHED');
  }

  @EventPattern(KAFKA_TOPICS.EVENT_UPDATED)
  async onUpdated(@Payload() raw: unknown): Promise<void> {
    return this.upsert(raw, 'EVENT_UPDATED');
  }

  private async upsert(raw: unknown, topic: string): Promise<void> {
    const parsed = EventReplicatedEventSchema.safeParse(raw);
    if (!parsed.success) {
      this.logger.warn(`${topic} inválido`, { issues: parsed.error.issues });
      return;
    }
    const e = parsed.data;
    await this.prisma.event.upsert({
      where: { id: e.id },
      create: {
        id: e.id,
        organizerId: e.organizerId,
        title: e.title,
        slug: e.slug,
        startAt: e.startAt,
        endAt: e.endAt,
        venueCity: e.venueCity,
        venueState: e.venueState,
        thumbnailUrl: e.thumbnailUrl,
      },
      update: {
        organizerId: e.organizerId,
        title: e.title,
        slug: e.slug,
        startAt: e.startAt,
        endAt: e.endAt,
        venueCity: e.venueCity,
        venueState: e.venueState,
        thumbnailUrl: e.thumbnailUrl,
        lastSyncAt: new Date(),
      },
    });
  }
}
