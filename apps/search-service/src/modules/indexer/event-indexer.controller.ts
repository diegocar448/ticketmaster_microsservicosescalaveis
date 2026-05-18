// apps/search-service/src/modules/indexer/event-indexer.controller.ts
//
// Consome events.event-* e mantém o índice "events" sincronizado.
// at-least-once do Kafka: es.index() com o MESMO id é idempotente
// (mesma chave = update, sem violação de PK).

import { Controller, Logger } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { ElasticsearchService } from '@nestjs/elasticsearch';
import { KAFKA_TOPICS, EventReplicatedEventSchema } from '@showpass/types';
import { EVENT_INDEX } from '../search/event-index.js';
import { z } from 'zod';

@Controller()
export class EventIndexerController {
  private readonly logger = new Logger(EventIndexerController.name);

  constructor(private readonly es: ElasticsearchService) {}

  @EventPattern(KAFKA_TOPICS.EVENT_PUBLISHED)
  async onPublished(@Payload() raw: unknown): Promise<void> {
    return this.upsert(raw, 'EVENT_PUBLISHED');
  }

  @EventPattern(KAFKA_TOPICS.EVENT_UPDATED)
  async onUpdated(@Payload() raw: unknown): Promise<void> {
    return this.upsert(raw, 'EVENT_UPDATED');
  }

  /**
   * EVENT_CANCELLED tem payload diferente: { eventId, organizerId }.
   * Emitido em events.service.ts:transitionStatus quando status='cancelled'.
   */
  @EventPattern(KAFKA_TOPICS.EVENT_CANCELLED)
  async onCancelled(@Payload() raw: unknown): Promise<void> {
    const parsed = z
      .object({ eventId: z.uuid(), organizerId: z.uuid() })
      .safeParse(raw);
    if (!parsed.success) {
      this.logger.warn('EVENT_CANCELLED inválido', {
        issues: parsed.error.issues,
      });
      return;
    }
    await this.removeFromIndex(parsed.data.eventId);
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private async upsert(raw: unknown, topic: string): Promise<void> {
    const parsed = EventReplicatedEventSchema.safeParse(raw);
    if (!parsed.success) {
      this.logger.error(`Payload inválido em ${topic}`, {
        issues: parsed.error.issues,
      });
      // Não relançar: nack infinito bloqueia a partição. Em prod: DLQ.
      return;
    }

    const e = parsed.data;

    // Só indexar status visíveis ao buyer; outros são removidos do índice.
    const indexable = ['published', 'on_sale', 'sold_out'];
    if (!indexable.includes(e.status)) {
      await this.removeFromIndex(e.id);
      return;
    }

    await this.es.index({
      index: EVENT_INDEX,
      id: e.id,
      document: {
        id: e.id,
        organizerId: e.organizerId,
        title: e.title,
        slug: e.slug,
        status: e.status,
        startAt: e.startAt,
        endAt: e.endAt,
        venueCity: e.venueCity,
        venueState: e.venueState,
        thumbnailUrl: e.thumbnailUrl,
      },
      // refresh: 'wait_for' garante read-your-write (útil em testes E2E).
      // Em prod com volume alto, omitir (default false) para throughput.
      refresh: process.env['NODE_ENV'] === 'production' ? false : 'wait_for',
    });

    this.logger.log(`Indexado: ${e.id} ("${e.title}")`);
  }

  private async removeFromIndex(eventId: string): Promise<void> {
    try {
      await this.es.delete({ index: EVENT_INDEX, id: eventId });
      this.logger.log(`Removido do índice: ${eventId}`);
    } catch (err) {
      // 404 é benigno: evento pode nunca ter sido indexado (ex: cancelado
      // antes de chegar a 'published'). Outros erros são relançados.
      if (
        (err as { meta?: { statusCode?: number } }).meta?.statusCode !== 404
      ) {
        throw err;
      }
    }
  }
}
