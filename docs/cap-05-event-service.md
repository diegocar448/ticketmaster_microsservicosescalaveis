# Capítulo 5 — Event Service

> **Objetivo:** Implementar o serviço de eventos — Organizers, Plans (SaaS multi-tenant), Venues com mapas de assentos, Events com máquina de estados, e emissão de eventos Kafka via CDC.

## O que você vai aprender

- Multi-tenancy: como o `organizerId` isola dados entre tenants
- Plans SaaS: checar limites de plano antes de criar recursos
- Venue com mapa de assentos gerado em bulk (500 assentos/seção)
- `EventStatus` como máquina de estados — transições válidas e inválidas
- Emitir eventos de domínio via Kafka quando o status muda
- Repository pattern sobre o Prisma — controllers nunca acessam o Prisma diretamente

---

## Passo 5.1 — `package.json` do Event Service

```json
{
  "name": "@showpass/event-service",
  "version": "0.0.1",
  "scripts": {
    "dev": "tsx watch src/main.ts",
    "build": "tsc --project tsconfig.build.json",
    "start": "node dist/main.js",
    "test": "jest",
    "lint": "eslint src",
    "type-check": "tsc --noEmit",
    "db:migrate": "prisma migrate deploy",
    "db:migrate:dev": "prisma migrate dev",
    "db:seed": "tsx prisma/seed.ts",
    "db:studio": "prisma studio"
  },
  "dependencies": {
    "@nestjs/common": "^11.0.0",
    "@nestjs/core": "^11.0.0",
    "@nestjs/platform-express": "^11.0.0",
    "@nestjs/swagger": "^8.0.0",
    "@showpass/types": "workspace:*",
    "@showpass/kafka": "workspace:*",
    "@prisma/client": "^7.0.0",
    "@showpass/redis": "workspace:*",
    "slugify": "^1.6.6",
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "prisma": "^7.0.0",
    "tsx": "^4.19.0",
    "typescript": "^6.0.0"
  }
}
```

---

## Passo 5.2 — Events Repository (abstração sobre Prisma)

```typescript
// apps/event-service/src/modules/events/events.repository.ts
//
// Repository pattern: encapsula todas as queries ao banco.
// Vantagens:
// 1. Controllers nunca importam PrismaService diretamente
// 2. Fácil de mockar nos testes (injetar um mock do repository)
// 3. Queries complexas ficam encapsuladas em métodos com nome semântico

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { Prisma } from '../prisma/generated';
import type { CreateEventDto, EventStatus } from '@showpass/types';

@Injectable()
export class EventsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    organizerId: string,
    dto: CreateEventDto & { slug: string },
  ) {
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
        thumbnailUrl: dto.thumbnailUrl,
        maxTicketsPerOrder: dto.maxTicketsPerOrder,
        ageRestriction: dto.ageRestriction,
        // Preencher colunas desnormalizadas na criação
        venueCity: '',   // preenchido no service após buscar venue
        venueState: '',
      },
      include: {
        venue: { select: { name: true, city: true, state: true } },
        category: { select: { name: true, slug: true } },
      },
    });
  }

  async findById(id: string, organizerId?: string) {
    return this.prisma.event.findFirst({
      where: {
        id,
        // Se organizerId fornecido, restringir ao tenant
        ...(organizerId ? { organizerId } : {}),
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

  async findBySlug(slug: string) {
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
  ) {
    const skip = (params.page - 1) * params.limit;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.event.findMany({
        where: {
          organizerId,
          ...(params.status ? { status: params.status } : {}),
        },
        orderBy: { startAt: 'asc' },
        skip,
        take: params.limit,
        include: {
          venue: { select: { name: true, city: true } },
          _count: { select: { ticketBatches: true } },
        },
      }),
      this.prisma.event.count({
        where: { organizerId, ...(params.status ? { status: params.status } : {}) },
      }),
    ]);

    return { items, total, page: params.page, limit: params.limit };
  }

  async updateStatus(id: string, organizerId: string, status: string) {
    return this.prisma.event.update({
      where: { id, organizerId },  // tenant isolation
      data: {
        status,
        publishedAt: status === 'published' ? new Date() : undefined,
      },
    });
  }

  async incrementSoldCount(eventId: string, ticketBatchId: string, quantity: number) {
    // Atualizar contadores desnormalizados em transação
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
```

---

## Passo 5.3 — Event Status Machine

```typescript
// apps/event-service/src/modules/events/event-status.ts
//
// Máquina de estados para o ciclo de vida de um evento.
// Define transições válidas — impossível pular etapas.

export const EVENT_STATUS = {
  DRAFT: 'draft',
  PUBLISHED: 'published',
  ON_SALE: 'on_sale',
  SOLD_OUT: 'sold_out',
  CANCELLED: 'cancelled',
  COMPLETED: 'completed',
} as const;

export type EventStatus = (typeof EVENT_STATUS)[keyof typeof EVENT_STATUS];

// Grafo de transições permitidas
const TRANSITIONS: Record<EventStatus, EventStatus[]> = {
  draft:     ['published', 'cancelled'],
  published: ['on_sale', 'cancelled'],
  on_sale:   ['sold_out', 'cancelled', 'completed'],
  sold_out:  ['on_sale', 'cancelled', 'completed'],  // pode ter cancelamentos
  cancelled: [],           // estado final — sem saída
  completed: [],           // estado final — sem saída
};

export class EventStatusMachine {
  static canTransition(from: EventStatus, to: EventStatus): boolean {
    return TRANSITIONS[from].includes(to);
  }

  /**
   * Valida a transição e lança erro se inválida.
   * Usado no service antes de atualizar o banco.
   */
  static assertTransition(from: EventStatus, to: EventStatus): void {
    if (!this.canTransition(from, to)) {
      throw new Error(
        `Transição inválida: ${from} → ${to}. ` +
        `Permitidas a partir de '${from}': [${TRANSITIONS[from].join(', ')}]`,
      );
    }
  }

  /**
   * Verifica se o evento pode receber novas reservas.
   */
  static isOnSale(status: EventStatus): boolean {
    return status === EVENT_STATUS.ON_SALE;
  }
}
```

---

## Passo 5.4 — Events Service

```typescript
// apps/event-service/src/modules/events/events.service.ts

import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import slugify from 'slugify';
import { EventsRepository } from './events.repository';
import { EventStatusMachine, type EventStatus } from './event-status';
import { KafkaProducerService } from '@showpass/kafka';
import { KAFKA_TOPICS } from '@showpass/types';
import type { CreateEventDto } from '@showpass/types';

@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(
    private readonly eventsRepo: EventsRepository,
    private readonly kafka: KafkaProducerService,
  ) {}

  async create(organizerId: string, dto: CreateEventDto) {
    // Gerar slug único a partir do título
    const baseSlug = slugify(dto.title, { lower: true, strict: true });
    const slug = `${baseSlug}-${Date.now()}`;

    const event = await this.eventsRepo.create(organizerId, { ...dto, slug });

    this.logger.log('Evento criado', { eventId: event.id, organizerId });

    return event;
  }

  async getById(id: string, organizerId?: string) {
    const event = await this.eventsRepo.findById(id, organizerId);

    if (!event) {
      throw new NotFoundException('Evento não encontrado');
    }

    return event;
  }

  async getBySlug(slug: string) {
    const event = await this.eventsRepo.findBySlug(slug);

    if (!event) {
      throw new NotFoundException('Evento não encontrado');
    }

    return event;
  }

  /**
   * Transição de status com validação da máquina de estados.
   * Emite evento Kafka quando o status muda para on_sale ou cancelled.
   */
  async transitionStatus(
    id: string,
    organizerId: string,
    newStatus: EventStatus,
  ) {
    const event = await this.eventsRepo.findById(id, organizerId);

    if (!event) {
      throw new NotFoundException('Evento não encontrado');
    }

    // Tenant isolation: organizer só pode alterar seus próprios eventos
    if (event.organizerId !== organizerId) {
      throw new ForbiddenException('Sem permissão para alterar este evento');
    }

    try {
      EventStatusMachine.assertTransition(event.status as EventStatus, newStatus);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }

    const updated = await this.eventsRepo.updateStatus(id, organizerId, newStatus);

    // Emitir evento de domínio para outros serviços reagirem
    if (newStatus === 'on_sale') {
      await this.kafka.emit(
        KAFKA_TOPICS.EVENT_PUBLISHED,
        {
          eventId: event.id,
          organizerId: event.organizerId,
          title: event.title,
          startAt: event.startAt,
          venueCity: event.venueCity,
        },
        event.id,  // key = eventId → mesma partição = ordem garantida
      );
    }

    if (newStatus === 'cancelled') {
      await this.kafka.emit(
        KAFKA_TOPICS.EVENT_CANCELLED,
        { eventId: event.id, organizerId: event.organizerId },
        event.id,
      );
    }

    return updated;
  }
}
```

---

## Passo 5.5 — Venue Service (bulk seat generation)

```typescript
// apps/event-service/src/modules/venues/venues.service.ts
//
// Cria venues com seções e assentos gerados em bulk.
// Um teatro com 2000 assentos precisa inserir 2000 registros —
// fazer isso um por um levaria segundos. Bulk insert em chunks: milissegundos.

import { Injectable, ForbiddenException, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { CreateVenueDto } from '@showpass/types';

interface CreateSectionInput {
  name: string;
  seatingType: 'reserved' | 'general_admission';
  rows: string[];   // ["A", "B", "C", ...]
  seatsPerRow: number;
}

@Injectable()
export class VenuesService {
  private readonly logger = new Logger(VenuesService.name);

  constructor(private readonly prisma: PrismaService) {}

  async create(
    organizerId: string,
    dto: CreateVenueDto,
    sections: CreateSectionInput[],
  ) {
    // Verificar limite do plano antes de criar
    const organizer = await this.prisma.organizer.findUnique({
      where: { id: organizerId },
      include: { plan: true, venues: { select: { id: true } } },
    });

    if (!organizer) throw new NotFoundException('Organizer não encontrado');

    if (organizer.venues.length >= organizer.plan.maxVenues) {
      throw new ForbiddenException(
        `Limite do plano atingido: máximo de ${organizer.plan.maxVenues} venues. ` +
        `Faça upgrade para criar mais.`,
      );
    }

    const venue = await this.prisma.$transaction(async (tx) => {
      // 1. Criar o venue
      const venue = await tx.venue.create({
        data: {
          organizerId,
          name: dto.name,
          address: dto.address,
          city: dto.city,
          state: dto.state,
          zipCode: dto.zipCode,
          latitude: dto.latitude,
          longitude: dto.longitude,
          capacity: dto.capacity,
        },
      });

      // 2. Criar seções e assentos em bulk
      for (const section of sections) {
        const createdSection = await tx.section.create({
          data: {
            venueId: venue.id,
            name: section.name,
            seatingType: section.seatingType,
            capacity: section.rows.length * section.seatsPerRow,
          },
        });

        if (section.seatingType === 'reserved') {
          // Gerar todos os assentos desta seção
          const seatsToCreate = this.generateSeats(
            createdSection.id,
            section.rows,
            section.seatsPerRow,
          );

          // Inserir em chunks de 500 — evita timeout e memória excessiva
          await this.bulkInsertSeats(tx, seatsToCreate);

          this.logger.log(
            `Seção "${section.name}": ${seatsToCreate.length} assentos criados`,
          );
        }
      }

      return venue;
    });

    return venue;
  }

  /**
   * Gera os dados dos assentos para uma seção.
   * Ex: rows=["A","B","C"], seatsPerRow=20 → 60 assentos
   */
  private generateSeats(
    sectionId: string,
    rows: string[],
    seatsPerRow: number,
  ): Array<{
    sectionId: string;
    row: string;
    number: number;
    type: string;
    mapX: number;
    mapY: number;
  }> {
    const seats = [];

    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const row = rows[rowIndex];

      for (let seatNum = 1; seatNum <= seatsPerRow; seatNum++) {
        seats.push({
          sectionId,
          row,
          number: seatNum,
          type: 'standard',
          // Coordenadas para o mapa SVG
          // Cada assento ocupa 30px, espaçamento de 5px
          mapX: (seatNum - 1) * 35,
          mapY: rowIndex * 35,
        });
      }
    }

    return seats;
  }

  /**
   * Insere assentos em chunks para não sobrecarregar o banco.
   * createMany é muito mais rápido que criar um por um.
   */
  private async bulkInsertSeats(
    tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
    seats: Array<{
      sectionId: string;
      row: string;
      number: number;
      type: string;
      mapX: number;
      mapY: number;
    }>,
    chunkSize = 500,
  ): Promise<void> {
    for (let i = 0; i < seats.length; i += chunkSize) {
      const chunk = seats.slice(i, i + chunkSize);
      await tx.seat.createMany({ data: chunk });
    }
  }
}
```

---

## Passo 5.6 — Events Controller

```typescript
// apps/event-service/src/modules/events/events.controller.ts

import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { EventsService } from './events.service';
import { OrganizerGuard } from '../../common/guards/organizer.guard';
import { CurrentUser, type AuthenticatedUser } from '@showpass/types';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { CreateEventSchema, type CreateEventDto } from '@showpass/types';
import { z } from 'zod';

const TransitionStatusSchema = z.object({
  status: z.enum(['published', 'on_sale', 'sold_out', 'cancelled', 'completed']),
});

@Controller('events')
export class EventsController {
  constructor(private readonly eventsService: EventsService) {}

  // ─── Rotas públicas (sem guard) ───────────────────────────────────────────

  /**
   * Página do evento — acesso público.
   * Usado pelo frontend para renderizar a página de compra de ingressos.
   */
  @Get(':slug/public')
  getBySlug(@Param('slug') slug: string) {
    return this.eventsService.getBySlug(slug);
  }

  // ─── Rotas de organizer (requer OrganizerGuard) ────────────────────────────

  @Post()
  @UseGuards(OrganizerGuard)
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(CreateEventSchema)) dto: CreateEventDto,
  ) {
    return this.eventsService.create(user.organizerId!, dto);
  }

  @Get()
  @UseGuards(OrganizerGuard)
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('status') status?: string,
    @Query('page') page = '1',
    @Query('limit') limit = '20',
  ) {
    return this.eventsService.listByOrganizer(user.organizerId!, {
      status: status as any,
      page: Number(page),
      limit: Math.min(Number(limit), 100),  // máximo 100 itens por página
    });
  }

  @Get(':id')
  @UseGuards(OrganizerGuard)
  getById(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    // Passar organizerId para garantir tenant isolation
    return this.eventsService.getById(id, user.organizerId!);
  }

  @Patch(':id/status')
  @UseGuards(OrganizerGuard)
  transitionStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(TransitionStatusSchema)) body: z.infer<typeof TransitionStatusSchema>,
  ) {
    return this.eventsService.transitionStatus(id, user.organizerId!, body.status);
  }
}
```

---

## Passo 5.7 — Seed de dados iniciais

```typescript
// apps/event-service/prisma/seed.ts
//
// Popula o banco com dados iniciais para desenvolvimento.
// Plans, Categories, e um Organizer de exemplo.

import { PrismaClient } from '../src/prisma/generated';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  // ─── Plans (SaaS tiers) ────────────────────────────────────────────────────
  await prisma.plan.upsert({
    where: { slug: 'free' },
    create: {
      name: 'Free',
      slug: 'free',
      maxActiveEvents: 2,
      maxVenues: 1,
      serviceFeePercent: 10.0,
      hasAnalytics: false,
      hasApiAccess: false,
      hasWhiteLabel: false,
      priceMonthly: 0,
    },
    update: {},
  });

  await prisma.plan.upsert({
    where: { slug: 'pro' },
    create: {
      name: 'Pro',
      slug: 'pro',
      maxActiveEvents: 20,
      maxVenues: 5,
      serviceFeePercent: 7.0,
      hasAnalytics: true,
      hasApiAccess: false,
      hasWhiteLabel: false,
      priceMonthly: 99.90,
    },
    update: {},
  });

  await prisma.plan.upsert({
    where: { slug: 'enterprise' },
    create: {
      name: 'Enterprise',
      slug: 'enterprise',
      maxActiveEvents: 999,
      maxVenues: 999,
      serviceFeePercent: 4.0,
      hasAnalytics: true,
      hasApiAccess: true,
      hasWhiteLabel: true,
      priceMonthly: 499.90,
    },
    update: {},
  });

  // ─── Categories ────────────────────────────────────────────────────────────
  const categories = [
    { name: 'Shows e Música', slug: 'shows-musica', icon: '🎵' },
    { name: 'Teatro e Dança', slug: 'teatro-danca', icon: '🎭' },
    { name: 'Esportes', slug: 'esportes', icon: '⚽' },
    { name: 'Conferências', slug: 'conferencias', icon: '🎤' },
    { name: 'Festivais', slug: 'festivais', icon: '🎪' },
    { name: 'Stand-up', slug: 'stand-up', icon: '🎙️' },
  ];

  for (const cat of categories) {
    await prisma.category.upsert({
      where: { slug: cat.slug },
      create: cat,
      update: {},
    });
  }

  console.log('✅ Seed concluído: plans e categories criados');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
```

---

## Passo 5.8 — Cache Layer (Cache-Aside Pattern)

> **Por que cache no Event Service?**  
> A razão leitura:escrita é 100:1. Para cada organizer que cria/edita um evento,
> existem ~100 compradores lendo aquele evento. Sem cache, cada visualização de
> página de evento bate no PostgreSQL — desnecessário e caro em picos de 10M usuários.

```typescript
// apps/event-service/src/modules/events/events.service.ts (adição ao getBySlug)
//
// Cache-Aside Pattern (também chamado Lazy Loading):
// 1. Verificar se o dado está no cache
// 2. Se estiver → retornar do cache (sub-millisegundo)
// 3. Se não estiver → buscar no banco, armazenar no cache, retornar

import { Injectable, NotFoundException } from '@nestjs/common';
import { RedisService } from '@showpass/redis';
import { EventsRepository } from './events.repository';

// TTL do cache por tipo de dado:
// Eventos em venda ativa → cache curto (ingressos disponíveis mudam rápido)
// Eventos encerrados     → cache longo (dados estáticos)
const CACHE_TTL = {
  on_sale:   30,     // 30 segundos — disponibilidade muda a todo momento
  published: 300,    // 5 minutos
  sold_out:  3600,   // 1 hora — não muda mais
  completed: 86400,  // 24 horas — evento encerrado
  default:   60,     // 1 minuto para outros status
} as const;

@Injectable()
export class EventsService {
  constructor(
    private readonly repo: EventsRepository,
    private readonly redis: RedisService,
    private readonly kafka: KafkaProducerService,
  ) {}

  /**
   * GET /events/:slug/public — página do evento (alta frequência de acesso).
   *
   * Fluxo:
   *   1. Verificar cache Redis  → retorna em ~0.1ms
   *   2. Cache miss → buscar no PostgreSQL → salvar no Redis → retornar
   *
   * Invalidação: quando o evento é atualizado (transitionStatus),
   * deletamos a chave do cache para forçar recarga na próxima leitura.
   */
  async getBySlug(slug: string) {
    const cacheKey = `event:slug:${slug}`;

    // Passo 1: tentar o cache primeiro
    const cached = await this.redis.get<EventDetail>(cacheKey);
    if (cached) {
      return cached;  // retorno em ~0.1ms — sem tocar no banco
    }

    // Passo 2: cache miss → buscar no banco
    const event = await this.repo.findBySlug(slug);
    if (!event) throw new NotFoundException(`Evento '${slug}' não encontrado`);

    // Passo 3: salvar no cache com TTL baseado no status do evento
    const ttl = CACHE_TTL[event.status as keyof typeof CACHE_TTL] ?? CACHE_TTL.default;
    await this.redis.set(cacheKey, event, ttl);

    return event;
  }

  /**
   * Quando o status do evento muda → invalidar cache.
   * Na próxima leitura, o cache será recarregado com os dados novos.
   */
  async transitionStatus(id: string, organizerId: string, newStatus: string) {
    const updated = await this.repo.transitionStatus(id, organizerId, newStatus);

    // Invalidar cache por slug E por id
    await Promise.all([
      this.redis.del(`event:slug:${updated.slug}`),
      this.redis.del(`event:id:${updated.id}`),
    ]);

    // ... emitir evento Kafka (código existente continua aqui)
    return updated;
  }
}
```

```
Impacto do cache em picos de evento:

  SEM cache:
    10.000 req/s × 5ms (query Postgres) = PostgreSQL sobrecarregado

  COM cache (TTL 30s para on_sale):
    Cache hit rate ~99%
    Apenas ~100 req/s chegam ao PostgreSQL (1 por TTL por slug único)
    PostgreSQL fica livre para operações de escrita (reservas, pagamentos)
```

---

## Recapitulando

1. **Repository pattern** — `EventsRepository` encapsula todas as queries Prisma; controllers ficam limpos
2. **Tenant isolation** — todas as queries passam `organizerId`; impossível acessar dados de outro tenant
3. **EventStatusMachine** — transições de status com grafo de estados válidos; impossível ir de `draft` direto para `completed`
4. **Bulk seat insert em chunks** — gerar 2000 assentos em ~50ms com `createMany` em lotes de 500
5. **Plan limits** — checados no service antes de criar venue/evento; mensagem clara sobre upgrade
6. **Cache-Aside com TTL por status** — event on_sale cacheia 30s; sold_out cacheia 1h; invalidação na mudança de status
7. **Kafka emit** — quando evento vai para `on_sale`, notifica search-service (para indexar) e outros consumidores

---

---

## Gotchas de versão (correções aplicadas)

| # | Problema | Causa | Correção |
|---|----------|-------|---------|
| 1 | `url = env("DATABASE_URL")` no schema.prisma | Prisma 7 removeu `url` do datasource block | Criar `prisma.config.ts` com `defineConfig({ datasourceUrl: ... })` |
| 2 | `import { PrismaClient } from '../src/prisma/generated'` no seed | Extensão `.js` obrigatória em NodeNext | Usar `from '../src/prisma/generated/index.js'` |
| 3 | `thumbnailUrl: dto.thumbnailUrl` causa TS2375 | Prisma espera `string \| null`, Zod retorna `string \| undefined` | Usar `dto.thumbnailUrl ?? null` (converte undefined → null) |
| 4 | `TRANSITIONS[from]` dispara `security/detect-object-injection` | Regra OWASP A03 detecta acesso dinâmico a objeto | Extrair para variável com `eslint-disable-next-line` documentado |
| 5 | `Date.now()` em template literal causa `restrict-template-expressions` | Regra restringe tipos não-string em templates | Usar `String(Date.now())` |
| 6 | `organizer.plan.maxVenues` em template literal | Mesmo motivo: número em template | Usar `String(organizer.plan.maxVenues)` |
| 7 | Falta `listByOrganizer` no `EventsService` | Tutorial mostra no controller mas omite no service | Adicionado o método delegando ao repository |
| 8 | `status as any` no controller | Tipo `EventStatus` não importado | Cast para `EventStatus` do `@showpass/types` |
| 9 | `user.organizerId!` viola `no-non-null-assertion` | Guard garante presença mas TypeScript não sabe | Método privado `assertOrganizerId` com `ForbiddenException` |
| 10 | Falta `@Global()` no PrismaModule | Sem isso, modules precisam importar PrismaModule individualmente | `PrismaModule` com `@Global()` no `AppModule` |
| 11 | `baseUrl` depreciado no tsconfig.json | TypeScript 6 deprecou `baseUrl` | Adicionar `"ignoreDeprecations": "6.0"` |
| 12 | `exactOptionalPropertyTypes` + `status?: EventStatus` | `status: status as EventStatus \| undefined` passa explicit undefined | Spread condicional: `...(status !== undefined ? { status: status as EventStatus } : {})` |

---

## Próximo capítulo

[Capítulo 6 → Booking Service](cap-06-booking-service.md)
