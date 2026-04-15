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
    "dev": "node --watch --loader @swc-node/register/esm src/main.ts",
    "build": "tsc --project tsconfig.build.json",
    "start": "node dist/main.js",
    "test": "jest",
    "lint": "eslint src",
    "type-check": "tsc --noEmit",
    "db:migrate": "prisma migrate deploy",
    "db:migrate:dev": "prisma migrate dev",
    "db:seed": "node --loader @swc-node/register/esm prisma/seed.ts",
    "db:studio": "prisma studio"
  },
  "type": "module",
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
    "@swc-node/register": "^1.10.0",
    "@types/node": "^22.0.0",
    "prisma": "^7.0.0",
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
//
// import 'dotenv/config' deve vir antes do PrismaClient — carrega DATABASE_URL do .env.
// Prisma 7 "client" engine exige driver adapter (@prisma/adapter-pg).

import 'dotenv/config';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/prisma/generated/index.js';

const pool = new Pool({ connectionString: process.env['DATABASE_URL'] });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

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

## Testando na prática

A partir daqui você cria o primeiro recurso de negócio real: venue + evento. Você precisa do token de organizer do Cap 04.

### O que precisa estar rodando

```bash
# Terminal 1 — infraestrutura
make infra-up

# Migrations e seed do event-service (apenas na primeira vez)
pnpm --filter @showpass/event-service run db:migrate
pnpm --filter @showpass/event-service run db:seed     # popula categories e plans

# Terminal 2 — todos os serviços em background (auth + event + api-gateway)
./scripts/dev.sh start

# Ver status e logs
./scripts/dev.sh status
./scripts/dev.sh logs event-service   # tail -f do event-service
```

> **Alternativa:** `make dev-services` é um alias para `./scripts/dev.sh start`.

### Preparar o token de organizer

```bash
TOKEN=$(curl -s -X POST http://localhost:3006/auth/organizers/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@rockshows.com.br","password":"Senha@Forte123"}' \
  | jq -r .accessToken)
echo "Token: $TOKEN"
```

> Se ainda não registrou o organizer, volte para a seção "Testando na prática" do Cap 04.

### Passo a passo

**1. Criar um venue (com geração de assentos)**

```bash
curl -s -X POST http://localhost:3003/venues \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Estádio do Maracanã",
    "city": "Rio de Janeiro",
    "state": "RJ",
    "country": "BR",
    "address": "Av. Presidente Castelo Branco, s/n",
    "zipCode": "20271-130",
    "capacity": 78838,
    "rows": 100,
    "seatsPerRow": 80
  }' | jq .
```

Resposta esperada:

```json
{
  "id": "018e1234-5678-7abc-def0-111213141516",
  "name": "Estádio do Maracanã",
  "city": "Rio de Janeiro",
  "state": "RJ",
  "capacity": 78838,
  "totalSeats": 8000
}
```

Salve o `id` do venue:

```bash
VENUE_ID="018e1234-..."   # substitua pelo id retornado
```

**2. Buscar o ID da categoria**

```bash
curl -s http://localhost:3003/categories | jq .
```

Salve um `id`:

```bash
CATEGORY_ID="018e..."   # substitua pelo id retornado
```

**3. Criar um evento**

```bash
curl -s -X POST http://localhost:3003/events \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"title\": \"Rock in Rio 2025\",
    \"slug\": \"rock-in-rio-2025\",
    \"description\": \"O maior festival do Brasil\",
    \"categoryId\": \"$CATEGORY_ID\",
    \"venueId\": \"$VENUE_ID\",
    \"startsAt\": \"2025-09-26T18:00:00.000Z\",
    \"endsAt\": \"2025-10-05T23:59:00.000Z\",
    \"maxTicketsPerOrder\": 4,
    \"currency\": \"BRL\"
  }" | jq .
```

Resposta esperada:

```json
{
  "id": "018e9999-...",
  "title": "Rock in Rio 2025",
  "slug": "rock-in-rio-2025",
  "status": "draft",
  "venue": { "name": "Estádio do Maracanã", "city": "Rio de Janeiro", "state": "RJ" },
  "category": { "name": "Música", "slug": "musica" }
}
```

Salve o `id` e o `slug`:

```bash
EVENT_ID="018e9999-..."
```

**4. Publicar o evento (draft → published)**

```bash
curl -s -X PATCH http://localhost:3003/events/$EVENT_ID/status \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status": "published"}' | jq .status
```

Resposta esperada: `"published"`

**5. Colocar à venda (published → on_sale)**

```bash
curl -s -X PATCH http://localhost:3003/events/$EVENT_ID/status \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status": "on_sale"}' | jq .status
```

**6. Buscar evento por slug (sem autenticação)**

```bash
curl -s http://localhost:3003/events/rock-in-rio-2025 | jq .
```

Chame duas vezes e observe que a segunda é mais rápida — o Redis cache foi populado na primeira chamada.

**7. Testar transição inválida de status**

```bash
# Tentar voltar de on_sale para draft (inválido)
curl -s -X PATCH http://localhost:3003/events/$EVENT_ID/status \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status": "draft"}' | jq .
```

Resposta esperada: `400 Bad Request` com mensagem sobre transição inválida.

**8. Tenant isolation — outro organizer não vê seus eventos**

```bash
# Criar outro organizer
curl -s -X POST http://localhost:3006/auth/organizers/register \
  -H "Content-Type: application/json" \
  -d '{"name":"Outro","email":"outro@teste.com","password":"Outro@Senha1"}' > /dev/null

OTHER_TOKEN=$(curl -s -X POST http://localhost:3006/auth/organizers/login \
  -H "Content-Type: application/json" \
  -d '{"email":"outro@teste.com","password":"Outro@Senha1"}' | jq -r .accessToken)

# Tentar editar evento do primeiro organizer com o token do segundo
curl -s -X PATCH http://localhost:3003/events/$EVENT_ID/status \
  -H "Authorization: Bearer $OTHER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status": "draft"}' | jq .
```

Resposta esperada: `403 Forbidden` ou `404 Not Found` — o segundo organizer não tem acesso.

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

## Gotchas de versão (correções aplicadas)

| # | Problema | Causa | Correção |
|---|----------|-------|---------|
| 1 | `url = env("DATABASE_URL")` no schema.prisma | Prisma 7 removeu `url` do datasource block | Criar `prisma.config.ts` com `defineConfig({ datasource: { url: process.env['DATABASE_URL'] } })` e `import 'dotenv/config'` no topo |
| 1b | `new PrismaClient()` falha com "requires adapter or accelerateUrl" | Prisma 7 "client" engine exige driver adapter | Instalar `@prisma/adapter-pg` + `pg`; passar `new Pool` + `new PrismaPg` no construtor |
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
| 13 | CI falha com `Unsafe call of a type that could not be resolved` | `src/prisma/generated/` está no `.gitignore` — não existe no runner | Ver seção abaixo |

---

## CI: Prisma Client não existe no runner do GitHub Actions

### Por que o erro acontece

O `src/prisma/generated/` está no `.gitignore` por um bom motivo: é código gerado automaticamente a partir do `schema.prisma`. Versionar código gerado cria conflitos de merge e polui o histórico. O correto é gerá-lo durante o build.

Mas o CI roda `eslint` sem ter gerado o cliente antes:

```
pnpm install           # instala dependências, NÃO roda prisma generate
pnpm turbo run lint    # ESLint tenta analisar this.prisma.buyer.findUnique(...)
                       # src/prisma/generated/ não existe → PrismaClient é unknown
                       # → 96 erros "Unsafe call of a type that could not be resolved"
```

### A fix: `db:generate` como dependência do `lint`

**Passo 1** — Adicionar o script em cada serviço com Prisma (`package.json`):

```json
{
  "scripts": {
    "db:generate": "prisma generate"
  }
}
```

**Passo 2** — Declarar o task no `turbo.json` e torná-lo pré-requisito de `lint` e `type-check`:

```json
{
  "tasks": {
    "db:generate": {
      "outputs": ["src/prisma/generated/**", "prisma/generated/**"]
    },
    "lint": {
      "dependsOn": ["db:generate"],
      "inputs": ["$TURBO_DEFAULT$"]
    },
    "type-check": {
      "dependsOn": ["db:generate"],
      "inputs": ["$TURBO_DEFAULT$"]
    }
  }
}
```

Com isso, `pnpm turbo run lint` passa a executar:

```
db:generate (auth-service)   → gera src/prisma/generated/
db:generate (event-service)  → gera src/prisma/generated/
lint        (auth-service)   → ESLint com tipos Prisma disponíveis ✓
lint        (event-service)  → ESLint com tipos Prisma disponíveis ✓
```

Pacotes sem `db:generate` (ex: `@showpass/types`, `@showpass/kafka`) são silenciosamente ignorados pelo Turborepo.

> **Regra para os próximos capítulos:** todo novo serviço que usar Prisma precisa de `"db:generate": "prisma generate"` no `package.json` antes do primeiro PR. Sem isso, o CI vai falhar com os mesmos 96 erros.

### Cache do Turborepo

O campo `"outputs"` no task `db:generate` ativa o cache do Turborepo. Se o `schema.prisma` não mudou desde a última run, o Turbo **pula a geração** e usa o resultado em cache. O CI fica mais rápido a partir do segundo run.

---

## Próximo capítulo

[Capítulo 6 → Booking Service](cap-06-booking-service.md)
