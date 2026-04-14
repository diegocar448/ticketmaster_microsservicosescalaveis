// apps/event-service/src/modules/events/events.repository.ts
//
// Repository pattern: encapsula todas as queries ao banco.
//
// Vantagens:
// 1. Controllers nunca importam PrismaService diretamente
// 2. Fácil de mockar nos testes (injetar mock do repository)
// 3. Queries complexas ficam em métodos com nomes semânticos
// 4. Multi-tenant isolation centralizada — todo acesso passa organizerId

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { Event, Prisma } from '../../prisma/generated/index.js';
import type { CreateEventDto } from '@showpass/types';
import type { EventStatus } from './event-status.js';

// ─── Tipos de retorno dos métodos do repositório ──────────────────────────────

export type EventCreated = Prisma.EventGetPayload<{
  include: {
    venue: { select: { name: true; city: true; state: true } };
    category: { select: { name: true; slug: true } };
  };
}>;

export type EventWithDetails = Prisma.EventGetPayload<{
  include: {
    venue: true;
    category: true;
    ticketBatches: true;
  };
}>;

export type EventPublic = Prisma.EventGetPayload<{
  include: {
    venue: { include: { sections: { include: { seats: true } } } };
    category: true;
    ticketBatches: true;
    organizer: { select: { name: true; slug: true } };
  };
}>;

export type EventListItem = Prisma.EventGetPayload<{
  include: {
    venue: { select: { name: true; city: true } };
    _count: { select: { ticketBatches: true } };
  };
}>;

export type EventList = {
  items: EventListItem[];
  total: number;
  page: number;
  limit: number;
};

// ─── Repository ───────────────────────────────────────────────────────────────

@Injectable()
export class EventsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    organizerId: string,
    dto: CreateEventDto & { slug: string; venueCity: string; venueState: string },
  ): Promise<EventCreated> {
    return this.prisma.event.create({
      data: {
        organizerId,
        venueId: dto.venueId,
        categoryId: dto.categoryId,
        title: dto.title,
        slug: dto.slug,
        description: dto.description,
        startAt: dto.startAt,
        endAt: dto.endAt,
        venueCity: dto.venueCity,
        venueState: dto.venueState,
        // Campos opcionais: ?? null converte undefined → null (Prisma espera string|null, não undefined)
        // exactOptionalPropertyTypes: não podemos passar undefined explicitamente para propriedades nullable
        thumbnailUrl: dto.thumbnailUrl ?? null,
        maxTicketsPerOrder: dto.maxTicketsPerOrder,   // number (Zod .default(4) garante presença)
        ageRestriction: dto.ageRestriction ?? null,
      },
      include: {
        venue: { select: { name: true, city: true, state: true } },
        category: { select: { name: true, slug: true } },
      },
    });
  }

  async findById(id: string, organizerId?: string): Promise<EventWithDetails | null> {
    return this.prisma.event.findFirst({
      where: {
        id,
        // Se organizerId fornecido, restringir ao tenant (multi-tenancy)
        ...(organizerId !== undefined ? { organizerId } : {}),
      },
      include: {
        venue: true,
        category: true,
        ticketBatches: {
          where: { isVisible: true },
          orderBy: { price: 'asc' },
        },
      },
    });
  }

  async findBySlug(slug: string): Promise<EventPublic | null> {
    return this.prisma.event.findUnique({
      where: { slug },
      include: {
        venue: { include: { sections: { include: { seats: true } } } },
        category: true,
        ticketBatches: { where: { isVisible: true } },
        organizer: { select: { name: true, slug: true } },
      },
    });
  }

  async listByOrganizer(
    organizerId: string,
    params: { status?: EventStatus; page: number; limit: number },
  ): Promise<EventList> {
    const skip = (params.page - 1) * params.limit;
    const statusFilter = params.status !== undefined ? { status: params.status } : {};

    const [items, total] = await this.prisma.$transaction([
      this.prisma.event.findMany({
        where: { organizerId, ...statusFilter },
        orderBy: { startAt: 'asc' },
        skip,
        take: params.limit,
        include: {
          venue: { select: { name: true, city: true } },
          _count: { select: { ticketBatches: true } },
        },
      }),
      this.prisma.event.count({
        where: { organizerId, ...statusFilter },
      }),
    ]);

    return { items, total, page: params.page, limit: params.limit };
  }

  async updateStatus(id: string, organizerId: string, status: string): Promise<Event> {
    return this.prisma.event.update({
      where: { id, organizerId },  // tenant isolation
      data: {
        status,
        // publishedAt: registrar momento exato da publicação
        ...(status === 'published' ? { publishedAt: new Date() } : {}),
      },
    });
  }

  async incrementSoldCount(
    eventId: string,
    ticketBatchId: string,
    quantity: number,
  ): Promise<void> {
    // Transação garante consistência entre contadores do evento e do lote
    await this.prisma.$transaction([
      this.prisma.event.update({
        where: { id: eventId },
        data: {
          soldCount: { increment: quantity },
          reservedCount: { decrement: quantity },
        },
      }),
      this.prisma.ticketBatch.update({
        where: { id: ticketBatchId },
        data: {
          soldCount: { increment: quantity },
          reservedCount: { decrement: quantity },
        },
      }),
    ]);
  }
}
