// apps/event-service/src/modules/organizers/organizers.consumer.ts
//
// Consumer Kafka: mantém a tabela `organizers` local em sincronia com a fonte
// da verdade (auth-service). Ver packages/types/kafka-topics.ts para o schema
// do evento e o "porquê" dessa replicação.
//
// Princípios:
// 1. Só dados NÃO-sensíveis trafegam — passwordHash/role/email NUNCA chegam aqui.
// 2. Idempotência via upsert — Kafka pode re-entregar a mesma mensagem.
// 3. planSlug → planId local — UUIDs de Plan diferem entre os dois bancos,
//    mas slugs são estáveis (seedados em ambos com os mesmos valores).
// 4. Consumer não relança erro: payload inválido → log + skip (evita nack
//    infinito bloqueando a partição). Em prod: DLQ.

import { Controller, Logger } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  KAFKA_TOPICS,
  OrganizerReplicatedEventSchema,
} from '@showpass/types';

@Controller()
export class OrganizersConsumer {
  private readonly logger = new Logger(OrganizersConsumer.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * auth.organizer-created → upsert local.
   *
   * Upsert (não create) porque:
   * - Consumer pode reprocessar a mesma mensagem após crash antes do commit.
   * - Backfill de organizers existentes (re-emit do auth-service) deve ser no-op
   *   se já sincronizou.
   */
  @EventPattern(KAFKA_TOPICS.AUTH_ORGANIZER_CREATED)
  async onCreated(@Payload() rawPayload: unknown): Promise<void> {
    await this.upsertOrganizer(rawPayload, 'AUTH_ORGANIZER_CREATED');
  }

  /**
   * auth.organizer-updated → upsert (não update).
   *
   * Se a mensagem UPDATED chegar antes da CREATED (raro: reprocessamento
   * cross-partition, backfill fora de ordem), ainda queremos criar o registro.
   * Kafka só garante ordem DENTRO da mesma partição (particionamos por id).
   */
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

    // Resolver planSlug → planId local. Os Plans são seedados em ambos os
    // bancos com os mesmos slugs (free/pro/enterprise), mas UUIDs distintos.
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
