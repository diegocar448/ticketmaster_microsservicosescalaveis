// apps/booking-service/src/modules/ticket-batches/ticket-batches.consumer.ts
//
// Consumer Kafka: mantém a réplica local de `ticket_batches` sincronizada
// com o event-service.
//
// Princípios desta réplica:
// 1. Eventual consistency aceita — delay típico <1s no fluxo feliz.
// 2. Idempotência obrigatória — Kafka pode entregar a mesma mensagem 2× em caso
//    de falha+reprocessamento. Usar `upsert` garante que o 2º apply é no-op.
// 3. Contadores (reservedCount/soldCount) NÃO vêm via replicação — eles são
//    owned pelo booking-service. O consumer preenche só os campos "config".
// 4. Ordem é preservada via `key=batchId` no producer — mensagens do mesmo
//    batch caem na mesma partição, então created sempre chega antes de updated.

import { Controller, Logger } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  KAFKA_TOPICS,
  TicketBatchCreatedEventSchema,
  TicketBatchUpdatedEventSchema,
  TicketBatchDeletedEventSchema,
} from '@showpass/types';

@Controller()
export class TicketBatchesConsumer {
  private readonly logger = new Logger(TicketBatchesConsumer.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * events.ticket-batch-created → upsert local.
   *
   * Por que upsert e não create?
   * Se o consumer processou esta mensagem, crashou antes do commit do offset
   * no Kafka, e reprocessou — create daria PK violation. Upsert torna idempotente.
   */
  @EventPattern(KAFKA_TOPICS.TICKET_BATCH_CREATED)
  async onCreated(@Payload() rawPayload: unknown): Promise<void> {
    // Payload chega já deserializado (JSON) — validar com Zod antes de confiar
    const parsed = TicketBatchCreatedEventSchema.safeParse(rawPayload);
    if (!parsed.success) {
      this.logger.error('Payload inválido em TICKET_BATCH_CREATED', {
        errors: parsed.error.issues,
      });
      // NÃO relançar: nack infinito bloqueia a partição.
      // Em produção: mover para DLQ (dead-letter queue).
      return;
    }

    const event = parsed.data;

    await this.prisma.ticketBatch.upsert({
      where: { id: event.id },
      create: {
        id: event.id,
        eventId: event.eventId,
        sectionId: event.sectionId,
        name: event.name,
        price: event.price,
        totalQuantity: event.totalQuantity,
        saleStartAt: event.saleStartAt,
        saleEndAt: event.saleEndAt,
        isVisible: event.isVisible,
        // reservedCount/soldCount default=0 — owned localmente
      },
      update: {
        // Se já existe (replay), atualizar campos configuráveis sem tocar contadores
        eventId: event.eventId,
        sectionId: event.sectionId,
        name: event.name,
        price: event.price,
        totalQuantity: event.totalQuantity,
        saleStartAt: event.saleStartAt,
        saleEndAt: event.saleEndAt,
        isVisible: event.isVisible,
        lastSyncAt: new Date(),
      },
    });

    this.logger.log(`TicketBatch replicado: id=${event.id}, eventId=${event.eventId}`);
  }

  /**
   * events.ticket-batch-updated → update só dos campos configuráveis.
   *
   * Trata também o caso raro: mensagem UPDATED chega antes de CREATED (produtor
   * out-of-order ou reprocessamento cross-partition). Nesse caso usar upsert.
   */
  @EventPattern(KAFKA_TOPICS.TICKET_BATCH_UPDATED)
  async onUpdated(@Payload() rawPayload: unknown): Promise<void> {
    const parsed = TicketBatchUpdatedEventSchema.safeParse(rawPayload);
    if (!parsed.success) {
      this.logger.error('Payload inválido em TICKET_BATCH_UPDATED', {
        errors: parsed.error.issues,
      });
      return;
    }

    const event = parsed.data;

    await this.prisma.ticketBatch.upsert({
      where: { id: event.id },
      // Se não existe, criar como se fosse CREATED — cobre corner case de
      // ordem cross-key que o Kafka não garante entre partições diferentes.
      create: {
        id: event.id,
        eventId: event.eventId,
        sectionId: event.sectionId,
        name: event.name,
        price: event.price,
        totalQuantity: event.totalQuantity,
        saleStartAt: event.saleStartAt,
        saleEndAt: event.saleEndAt,
        isVisible: event.isVisible,
      },
      update: {
        sectionId: event.sectionId,
        name: event.name,
        price: event.price,
        totalQuantity: event.totalQuantity,
        saleStartAt: event.saleStartAt,
        saleEndAt: event.saleEndAt,
        isVisible: event.isVisible,
        lastSyncAt: new Date(),
      },
    });

    this.logger.log(`TicketBatch atualizado: id=${event.id}`);
  }

  /**
   * events.ticket-batch-deleted → soft delete local.
   *
   * Por que NÃO fazer hard delete?
   * ReservationItems antigas referenciam `ticketBatchId` (sem FK, mas a aplicação
   * lê esse campo em relatórios de histórico). Deletar o batch quebraria queries
   * de auditoria. Marcar `isVisible=false` mantém a integridade referencial lógica.
   */
  @EventPattern(KAFKA_TOPICS.TICKET_BATCH_DELETED)
  async onDeleted(@Payload() rawPayload: unknown): Promise<void> {
    const parsed = TicketBatchDeletedEventSchema.safeParse(rawPayload);
    if (!parsed.success) {
      this.logger.error('Payload inválido em TICKET_BATCH_DELETED', {
        errors: parsed.error.issues,
      });
      return;
    }

    const event = parsed.data;

    // updateMany em vez de update — se não existe, vira no-op (idempotente)
    await this.prisma.ticketBatch.updateMany({
      where: { id: event.id },
      data: { isVisible: false, lastSyncAt: new Date() },
    });

    this.logger.log(`TicketBatch marcado como invisível: id=${event.id}`);
  }
}
