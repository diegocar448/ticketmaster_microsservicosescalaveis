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
import { KAFKA_TOPICS, OrganizerReplicatedEventSchema } from '@showpass/types';
import { PrismaService } from '../../prisma/prisma.service.js';

@Controller()
export class OrganizersConsumer {
  private readonly logger = new Logger(OrganizersConsumer.name);

  constructor(private readonly prisma: PrismaService) {}

  @EventPattern(KAFKA_TOPICS.AUTH_ORGANIZER_CREATED)
  async onCreated(@Payload() message: unknown): Promise<void> {
    const parsed = OrganizerReplicatedEventSchema.safeParse(message);
    if (!parsed.success) {
      this.logger.warn('auth.organizer.created inválido', { issues: parsed.error.issues });
      return;
    }

    const { id, name, slug, planSlug } = parsed.data;

    // planSlug → planId: os UUIDs diferem entre bancos (cada DB seedou o seu),
    // mas o slug é estável. Por isso o evento carrega planSlug, não planId.
    const plan = await this.prisma.plan.findUnique({ where: { slug: planSlug } });
    if (!plan) {
      this.logger.error('plano inexistente no payment-service', { planSlug });
      return;
    }

    await this.prisma.organizer.upsert({
      where: { id },
      create: { id, name, slug, planId: plan.id, lastSyncAt: new Date() },
      update: { name, slug, planId: plan.id, lastSyncAt: new Date() },
    });
  }

  @EventPattern(KAFKA_TOPICS.AUTH_ORGANIZER_UPDATED)
  async onUpdated(@Payload() message: unknown): Promise<void> {
    const parsed = OrganizerReplicatedEventSchema.safeParse(message);
    if (!parsed.success) return;

    const { id, name, slug, planSlug } = parsed.data;
    const plan = await this.prisma.plan.findUnique({ where: { slug: planSlug } });
    if (!plan) return;

    await this.prisma.organizer.upsert({
      where: { id },
      create: { id, name, slug, planId: plan.id, lastSyncAt: new Date() },
      update: { name, slug, planId: plan.id, lastSyncAt: new Date() },
    });
  }
}