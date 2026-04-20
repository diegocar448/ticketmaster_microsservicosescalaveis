// apps/event-service/src/modules/ticket-batches/ticket-batches.repository.ts
//
// Repository do TicketBatch.
// Toda query checa organizerId (via join no Event) — tenant isolation:
// um organizer nunca vê/altera batches de outro.

import { Injectable, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { TicketBatch } from '../../prisma/generated/index.js';
import type { CreateTicketBatchDto, UpdateTicketBatchDto } from '@showpass/types';

@Injectable()
export class TicketBatchesRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Cria um TicketBatch validando que o evento pertence ao organizer.
   * Retorna o batch criado junto com o organizerId do evento (para o Kafka event).
   */
  async create(
    eventId: string,
    organizerId: string,
    dto: CreateTicketBatchDto,
  ): Promise<TicketBatch & { organizerId: string }> {
    // Checagem antes de criar: evento existe e é do organizer
    // Combinar em um único findFirst evita race com ownership transfer
    const event = await this.prisma.event.findFirst({
      where: { id: eventId, organizerId },
      select: { id: true, organizerId: true },
    });

    if (!event) {
      // Mesma mensagem de "não encontrado" para não vazar existência a terceiros
      throw new ForbiddenException('Evento não encontrado ou sem permissão');
    }

    const batch = await this.prisma.ticketBatch.create({
      data: {
        eventId,
        name: dto.name,
        price: dto.price,
        totalQuantity: dto.totalQuantity,
        saleStartAt: dto.saleStartAt,
        saleEndAt: dto.saleEndAt,
        sectionId: dto.sectionId ?? null,
        isVisible: dto.isVisible,
      },
    });

    return { ...batch, organizerId: event.organizerId };
  }

  async listByEvent(eventId: string, organizerId: string): Promise<TicketBatch[]> {
    // Join implícito: batches só retornam se o evento for do organizer
    return this.prisma.ticketBatch.findMany({
      where: { eventId, event: { organizerId } },
      orderBy: [{ price: 'asc' }, { name: 'asc' }],
    });
  }

  async findById(
    batchId: string,
    organizerId: string,
  ): Promise<TicketBatch | null> {
    return this.prisma.ticketBatch.findFirst({
      where: { id: batchId, event: { organizerId } },
    });
  }

  /**
   * Update com validação de regra de negócio:
   * totalQuantity novo não pode ser menor que soldCount + reservedCount.
   * Validar no repository (não no controller) porque precisa ler o estado atual.
   */
  async update(
    batchId: string,
    organizerId: string,
    dto: UpdateTicketBatchDto,
  ): Promise<(TicketBatch & { organizerId: string }) | null> {
    const existing = await this.prisma.ticketBatch.findFirst({
      where: { id: batchId, event: { organizerId } },
      include: { event: { select: { organizerId: true } } },
    });

    if (!existing) return null;

    if (
      dto.totalQuantity !== undefined &&
      dto.totalQuantity < existing.soldCount + existing.reservedCount
    ) {
      throw new ForbiddenException(
        `totalQuantity não pode ser menor que ingressos já vendidos/reservados ` +
        `(atual: ${String(existing.soldCount + existing.reservedCount)})`,
      );
    }

    const updated = await this.prisma.ticketBatch.update({
      where: { id: batchId },
      // Spread condicional: exactOptionalPropertyTypes não aceita undefined explícito
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.price !== undefined ? { price: dto.price } : {}),
        ...(dto.totalQuantity !== undefined ? { totalQuantity: dto.totalQuantity } : {}),
        ...(dto.saleStartAt !== undefined ? { saleStartAt: dto.saleStartAt } : {}),
        ...(dto.saleEndAt !== undefined ? { saleEndAt: dto.saleEndAt } : {}),
        ...(dto.isVisible !== undefined ? { isVisible: dto.isVisible } : {}),
      },
    });

    return { ...updated, organizerId: existing.event.organizerId };
  }

  /**
   * Deleta batch. Retorna os dados do batch deletado para emissão do Kafka event.
   * Regra: não permitir delete se houver venda/reserva ativa.
   */
  async delete(
    batchId: string,
    organizerId: string,
  ): Promise<{ id: string; eventId: string } | null> {
    const existing = await this.prisma.ticketBatch.findFirst({
      where: { id: batchId, event: { organizerId } },
      select: {
        id: true,
        eventId: true,
        soldCount: true,
        reservedCount: true,
      },
    });

    if (!existing) return null;

    if (existing.soldCount > 0 || existing.reservedCount > 0) {
      throw new ForbiddenException(
        'Não é possível deletar um lote com ingressos vendidos ou reservados. ' +
        'Use isVisible=false para ocultar do público.',
      );
    }

    await this.prisma.ticketBatch.delete({ where: { id: batchId } });

    return { id: existing.id, eventId: existing.eventId };
  }
}
