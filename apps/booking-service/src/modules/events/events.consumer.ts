// apps/booking-service/src/modules/events/events.consumer.ts
//
// Consumer Kafka: mantém a réplica local de `events` sincronizada com o
// event-service. Dados usados pelo payment-service para montar line_items do
// Stripe Checkout (title + thumbnailUrl). Ver schema.prisma:Event.
//
// Princípios idênticos aos demais consumers do booking-service:
// 1. Eventual consistency aceita — delay típico <1s.
// 2. Idempotência obrigatória — Kafka at-least-once, usar upsert.
// 3. Sem validação de FK cross-service — integridade via eventos.
// 4. Payload validado com Zod antes de tocar no banco (defesa em profundidade).

import { Controller, Logger } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { PrismaService } from '../../prisma/prisma.service.js';
import { KAFKA_TOPICS, EventReplicatedEventSchema } from '@showpass/types';

@Controller()
export class EventsConsumer {
  private readonly logger = new Logger(EventsConsumer.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * events.event-published → upsert da réplica local.
   *
   * Upsert (não create) porque:
   * - Kafka at-least-once: consumer pode reprocessar a mesma mensagem após crash
   *   antes do commit de offset. Upsert idempotente evita PK violation.
   * - Se o organizer republicar o evento depois de um rascunho, o mesmo id
   *   chega novamente — update mantém o registro vivo.
   */
  @EventPattern(KAFKA_TOPICS.EVENT_PUBLISHED)
  async onPublished(@Payload() rawPayload: unknown): Promise<void> {
    const parsed = EventReplicatedEventSchema.safeParse(rawPayload);
    if (!parsed.success) {
      this.logger.error('Payload inválido em EVENT_PUBLISHED', {
        errors: parsed.error.issues,
      });
      // NÃO relançar — nack infinito bloqueia a partição.
      // Em produção: roteamento para DLQ (dead-letter queue).
      return;
    }

    const event = parsed.data;

    await this.prisma.event.upsert({
      where: { id: event.id },
      create: {
        id: event.id,
        organizerId: event.organizerId,
        title: event.title,
        slug: event.slug,
        status: event.status,
        startAt: event.startAt,
        endAt: event.endAt,
        venueCity: event.venueCity,
        venueState: event.venueState,
        thumbnailUrl: event.thumbnailUrl,
      },
      update: {
        organizerId: event.organizerId,
        title: event.title,
        slug: event.slug,
        status: event.status,
        startAt: event.startAt,
        endAt: event.endAt,
        venueCity: event.venueCity,
        venueState: event.venueState,
        thumbnailUrl: event.thumbnailUrl,
        lastSyncAt: new Date(),
      },
    });

    this.logger.log(`Event replicado: id=${event.id}, title="${event.title}"`);
  }

  /**
   * events.event-updated → mesmo payload do published, semântica diferente.
   *
   * Usa o mesmo schema/consumer porque o formato é idêntico — o event-service
   * emite o snapshot completo em ambos os tópicos. Separar os tópicos facilita
   * auditoria (quem republica vs quem só renomeia) sem duplicar lógica aqui.
   */
  @EventPattern(KAFKA_TOPICS.EVENT_UPDATED)
  async onUpdated(@Payload() rawPayload: unknown): Promise<void> {
    // Delegar: idempotência do upsert cobre tanto "primeira aparição" quanto
    // "update posterior". Se UPDATE chega antes de PUBLISHED (out-of-order
    // cross-partition), create do upsert garante que não perdemos a mensagem.
    return this.onPublished(rawPayload);
  }
}
