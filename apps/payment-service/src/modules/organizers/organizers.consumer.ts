// apps/payment-service/src/modules/organizers/organizers.consumer.ts
//
// Mantém `organizers` e o join com `plans` em sincronia com o auth-service.
// Copy-and-adapt do OrganizersConsumer em event-service.
//
// Por que replicar aqui? Para resolver `serviceFeePercent` (do Plan) no ato
// do checkout sem HTTP round-trip ao event-service. Slugs de plano são
// estáveis (seedados idênticos em todos os bancos); UUIDs variam por banco.

import { Controller, Logger } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import {
  KAFKA_TOPICS,
  OrganizerReplicatedEventSchema,
} from '@showpass/types';

import { PrismaService } from '../../prisma/prisma.service.js';

@Controller()
export class OrganizersConsumer {
  private readonly logger = new Logger(OrganizersConsumer.name);

  constructor(private readonly prisma: PrismaService) {}

  @EventPattern(KAFKA_TOPICS.AUTH_ORGANIZER_CREATED)
  async onCreated(@Payload() rawPayload: unknown): Promise<void> {
    await this.upsertOrganizer(rawPayload, 'AUTH_ORGANIZER_CREATED');
  }

  @EventPattern(KAFKA_TOPICS.AUTH_ORGANIZER_UPDATED)
  async onUpdated(@Payload() rawPayload: unknown): Promise<void> {
    await this.upsertOrganizer(rawPayload, 'AUTH_ORGANIZER_UPDATED');
  }

  private async upsertOrganizer(rawPayload: unknown, topic: string): Promise<void> {
    const parsed = OrganizerReplicatedEventSchema.safeParse(rawPayload);
    if (!parsed.success) {
      this.logger.error(`Payload inválido em ${topic}`, { errors: parsed.error.issues });
      return;
    }

    const event = parsed.data;

    const plan = await this.prisma.plan.findUnique({
      where: { slug: event.planSlug },
      select: { id: true },
    });

    if (!plan) {
      this.logger.error(
        `${topic}: plan com slug "${event.planSlug}" não existe — rode o seed de Plans antes`,
      );
      return;
    }

    await this.prisma.organizer.upsert({
      where: { id: event.id },
      create: {
        id: event.id,
        name: event.name,
        slug: event.slug,
        planId: plan.id,
        lastSyncAt: new Date(),
      },
      update: {
        name: event.name,
        slug: event.slug,
        planId: plan.id,
        lastSyncAt: new Date(),
      },
    });

    this.logger.log(`Organizer replicado (${topic}): id=${event.id}, slug=${event.slug}`);
  }
}
