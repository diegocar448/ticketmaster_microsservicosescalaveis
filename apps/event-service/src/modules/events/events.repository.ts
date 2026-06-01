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

// ─── Tipos do dashboard ───────────────────────────────────────────────────────

export type DashboardStats = {
  totalRevenue: number;
  totalTicketsSold: number;
  activeEvents: number;
  conversionRate: number; // sempre 0 — ver comentário no método (cap-17)
  revenueByDay: Array<{ date: string; revenue: number; tickets: number }>;
  topEvents: Array<{
    id: string;
    title: string;
    sold: number;
    available: number;
    revenue: number;
  }>;
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

  /**
   * Agrega métricas do organizer a partir de eventos e lotes de ingressos.
   *
   * Por que calcular em JS e não no banco?
   *   groupBy do Prisma não suporta cálculos com colunas de tabelas
   *   relacionadas num único aggregate. Trazer os lotes e computar em JS é
   *   aceitável para o volume de eventos de um único organizer (dezenas/
   *   centenas, não milhões).
   *
   * TRADE-OFFS HONESTOS:
   *  1. totalRevenue é ESTIMATIVA bruta — Σ(soldCount × price) no event-service.
   *     A fonte financeira autoritativa é o payment-service (pagamentos
   *     confirmados pelo Stripe). Reconciliação fina fica para o cap-18.
   *  2. revenueByDay é ILUSTRATIVO — distribuímos a receita pelo dia de
   *     criação do evento (não há tabela de transações diárias aqui).
   *  3. conversionRate sempre 0 — views não são rastreadas (cap-17 adiciona
   *     OpenTelemetry). Retornamos 0 tipado para não quebrar o frontend.
   */
  async getDashboardStats(organizerId: string): Promise<DashboardStats> {
    // tenant isolation: SEMPRE filtrar por organizerId
    const events = await this.prisma.event.findMany({
      where: { organizerId },
      include: {
        ticketBatches: {
          where: { isVisible: true },
          select: {
            price: true,
            soldCount: true,
            totalQuantity: true,
            reservedCount: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 100, // limite defensivo — organizers com muitos eventos
    });

    // ── Totais globais ──────────────────────────────────────────────────────
    let totalRevenue = 0;
    let totalTicketsSold = 0;
    for (const event of events) {
      for (const batch of event.ticketBatches) {
        const price = Number(batch.price); // Prisma Decimal → number
        totalRevenue += batch.soldCount * price;
        totalTicketsSold += batch.soldCount;
      }
    }

    const activeEvents = events.filter(
      (e) => e.status === 'published' || e.status === 'on_sale',
    ).length;

    // ── revenueByDay — últimos 30 dias (data de criação como aproximação) ────
    const revenueMap = new Map<string, { revenue: number; tickets: number }>();
    // Pré-popular com zeros garante que o gráfico não tenha lacunas
    for (let i = 29; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      revenueMap.set(d.toISOString().slice(0, 10), { revenue: 0, tickets: 0 });
    }

    for (const event of events) {
      const key = event.createdAt.toISOString().slice(0, 10);
      const entry = revenueMap.get(key);
      if (!entry) continue; // fora da janela de 30 dias
      for (const batch of event.ticketBatches) {
        const price = Number(batch.price);
        entry.revenue += batch.soldCount * price;
        entry.tickets += batch.soldCount;
      }
    }

    const revenueByDay = Array.from(revenueMap.entries()).map(([date, v]) => ({
      date,
      revenue: v.revenue,
      tickets: v.tickets,
    }));

    // ── Top eventos por soldCount ────────────────────────────────────────────
    const topEvents = events
      .map((event) => {
        const available =
          event.totalCapacity - event.soldCount - event.reservedCount;
        const revenue = event.ticketBatches.reduce(
          (sum, b) => sum + b.soldCount * Number(b.price),
          0,
        );
        return {
          id: event.id,
          title: event.title,
          sold: event.soldCount,
          available,
          revenue,
        };
      })
      .sort((a, b) => b.sold - a.sold)
      .slice(0, 10);

    return {
      totalRevenue,
      totalTicketsSold,
      activeEvents,
      conversionRate: 0, // real no cap-17 (OpenTelemetry + views tracking)
      revenueByDay,
      topEvents,
    };
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
