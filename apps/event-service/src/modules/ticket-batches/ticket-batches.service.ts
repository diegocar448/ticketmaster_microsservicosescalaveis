// apps/event-service/src/modules/ticket-batches/ticket-batches.service.ts
//
// Regras de negócio dos TicketBatches + emissão de eventos Kafka.
//
// Por que emitir Kafka aqui e não no repository?
//   O repository é pura persistência. Eventos de domínio pertencem ao service,
//   onde sabemos que a operação foi bem-sucedida como um todo (banco + regras).

import {
  Injectable,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { TicketBatchesRepository } from './ticket-batches.repository.js';
import { RedisService } from '@showpass/redis';
import { KafkaProducerService } from '@showpass/kafka';
import { KAFKA_TOPICS } from '@showpass/types';
import type {
  CreateTicketBatchDto,
  UpdateTicketBatchDto,
} from '@showpass/types';
import type { TicketBatch } from '../../prisma/generated/index.js';

@Injectable()
export class TicketBatchesService {
  private readonly logger = new Logger(TicketBatchesService.name);

  constructor(
    private readonly repo: TicketBatchesRepository,
    private readonly redis: RedisService,
    private readonly kafka: KafkaProducerService,
  ) {}

  async create(
    eventId: string,
    organizerId: string,
    dto: CreateTicketBatchDto,
  ): Promise<TicketBatch> {
    const batch = await this.repo.create(eventId, organizerId, dto);

    // Invalida cache do evento público — preço/disponibilidade do lote novo
    // precisa aparecer na próxima leitura do slug
    await this.invalidateEventCache(eventId);

    // Emite evento de domínio com snapshot completo.
    // Key = batch.id → todas as mensagens sobre o mesmo batch caem na mesma
    // partição, preservando ordem created → updated → deleted no consumer.
    await this.kafka.emit(
      KAFKA_TOPICS.TICKET_BATCH_CREATED,
      {
        id: batch.id,
        eventId: batch.eventId,
        organizerId: batch.organizerId,
        sectionId: batch.sectionId,
        name: batch.name,
        // Prisma retorna Decimal → toString → Zod coerce no consumer
        price: batch.price.toString(),
        totalQuantity: batch.totalQuantity,
        saleStartAt: batch.saleStartAt,
        saleEndAt: batch.saleEndAt,
        isVisible: batch.isVisible,
      },
      batch.id,
    );

    this.logger.log(`TicketBatch criado: id=${batch.id}, eventId=${eventId}`);

    // Remove organizerId (interno) do retorno público — só precisava para o Kafka
    const { organizerId: _ignored, ...publicBatch } = batch;
    return publicBatch;
  }

  async list(eventId: string, organizerId: string): Promise<TicketBatch[]> {
    return this.repo.listByEvent(eventId, organizerId);
  }

  async getById(batchId: string, organizerId: string): Promise<TicketBatch> {
    const batch = await this.repo.findById(batchId, organizerId);
    if (!batch) throw new NotFoundException('Lote não encontrado');
    return batch;
  }

  async update(
    batchId: string,
    organizerId: string,
    dto: UpdateTicketBatchDto,
  ): Promise<TicketBatch> {
    const updated = await this.repo.update(batchId, organizerId, dto);
    if (!updated) throw new NotFoundException('Lote não encontrado');

    await this.invalidateEventCache(updated.eventId);

    await this.kafka.emit(
      KAFKA_TOPICS.TICKET_BATCH_UPDATED,
      {
        id: updated.id,
        eventId: updated.eventId,
        sectionId: updated.sectionId,
        name: updated.name,
        price: updated.price.toString(),
        totalQuantity: updated.totalQuantity,
        saleStartAt: updated.saleStartAt,
        saleEndAt: updated.saleEndAt,
        isVisible: updated.isVisible,
      },
      updated.id,
    );

    this.logger.log(`TicketBatch atualizado: id=${batchId}`);

    const { organizerId: _ignored, ...publicBatch } = updated;
    return publicBatch;
  }

  async delete(batchId: string, organizerId: string): Promise<void> {
    const deleted = await this.repo.delete(batchId, organizerId);
    if (!deleted) throw new NotFoundException('Lote não encontrado');

    await this.invalidateEventCache(deleted.eventId);

    await this.kafka.emit(
      KAFKA_TOPICS.TICKET_BATCH_DELETED,
      { id: deleted.id, eventId: deleted.eventId },
      deleted.id,
    );

    this.logger.log(`TicketBatch deletado: id=${batchId}`);
  }

  /**
   * Invalida o cache `event:slug:*` do evento impactado.
   * Não conhecemos o slug aqui (só o eventId), então buscamos uma vez para achar.
   * Ao invalidar por ID + slug, cobrimos todas as chaves.
   */
  private async invalidateEventCache(eventId: string): Promise<void> {
    // Em produção, armazenar o mapeamento eventId→slug no Redis evitaria este SELECT.
    // Para o tutorial, o acoplamento é aceitável: alteração em lote é rara.
    await Promise.all([
      this.redis.del(`event:id:${eventId}`),
      // O slug não está disponível direto; padrão `event:slug:*` requer SCAN
      // (não fazer SCAN em produção — para o tutorial, invalidar por ID basta,
      // pois `getBySlug` usa `event:slug:*` que expira pelo TTL curto).
    ]);
  }
}
