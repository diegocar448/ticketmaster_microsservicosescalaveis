# Capítulo 2 — Shared Packages & Prisma

> **Objetivo:** Criar os pacotes compartilhados do monorepo — tipos Zod, abstrações de Kafka e Redis — e configurar o Prisma com schemas separados por bounded context.

## O que você vai aprender

- Zod como fonte única de verdade para tipos (compartilhado entre frontend e backend)
- Por que cada serviço tem seu próprio schema Prisma (bounded context no nível de dados)
- KafkaModule reutilizável com tipagem forte nos tópicos
- RedisModule com abstração sobre o `ioredis`
- Como o Turborepo resolve dependências entre pacotes internos

---

## Passo 2.1 — `packages/types` — Fonte Única de Verdade

```
packages/types/
├── src/
│   ├── index.ts
│   ├── events.ts
│   ├── bookings.ts
│   ├── payments.ts
│   ├── auth.ts
│   └── kafka-topics.ts
├── package.json
└── tsconfig.json
```

```json
// packages/types/package.json
{
  "name": "@showpass/types",
  "version": "0.0.1",
  "private": true,
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "type-check": "tsc --noEmit"
  },
  "dependencies": {
    "zod": "^4.0.0"
  }
}
```

---

### Zod 4 — Novidades que usamos neste tutorial

> **Zod 4** (lançado em 2025) trouxe mudanças importantes de API:
>
> | Zod 3 (antigo) | Zod 4 (atual) | O que mudou |
> |---|---|---|
> | `z.uuid()` | `z.uuid()` | Validador top-level — mais eficiente |
> | `z.url()` | `z.url()` | Validador top-level — suporta URLs relativas |
> | `z.string().email()` | `z.email()` | Validador top-level — RFC 5321 |
> | `z.string().base64()` | `z.base64()` | Validador top-level |
> | `z.ZodError` | `z.ZodError` | Compatível, mas internamente `z.core.$ZodError` |
> | `z.infer<T>` | `z.infer<T>` | Sem mudança |
>
> Os validadores antigos (`z.uuid()`) ainda funcionam como alias, mas a forma top-level é preferida e mais performática.

---

### Schemas Zod de Eventos

```typescript
// packages/types/src/events.ts
//
// Por que Zod e não interfaces TypeScript puras?
// Zod gera tanto o tipo estático (TypeScript) quanto a validação em runtime.
// Um único schema serve no frontend (validar resposta da API) e
// no backend (validar body do request) — sem duplicação.

import { z } from 'zod';

// ─── Enums ────────────────────────────────────────────────────────────────────

export const EventStatusSchema = z.enum([
  'draft',       // rascunho — organizador ainda configura
  'published',   // publicado — visível para compradores
  'on_sale',     // venda ativa — pode comprar ingressos
  'sold_out',    // esgotado
  'cancelled',   // cancelado — reembolsos disparados
  'completed',   // evento ocorreu — ingressos encerrados
]);

export type EventStatus = z.infer<typeof EventStatusSchema>;

export const SeatingTypeSchema = z.enum([
  'reserved',           // assento numerado
  'general_admission',  // área geral sem assento fixo
]);

export type SeatingType = z.infer<typeof SeatingTypeSchema>;

// ─── Venue ────────────────────────────────────────────────────────────────────

export const CreateVenueSchema = z.object({
  name: z.string().min(3).max(200),
  address: z.string().min(5).max(500),
  city: z.string().min(2).max(100),
  state: z.string().length(2),           // sigla do estado: SP, RJ, etc.
  zipCode: z.string().regex(/^\d{8}$/),  // apenas dígitos, sem hífen
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  capacity: z.number().int().positive(),
});

export type CreateVenueDto = z.infer<typeof CreateVenueSchema>;

// ─── Event ────────────────────────────────────────────────────────────────────

export const CreateEventSchema = z.object({
  venueId: z.uuid(),
  categoryId: z.uuid(),
  title: z.string().min(5).max(200),
  description: z.string().max(10_000),
  startAt: z.coerce.date(),    // aceita string ISO 8601 e converte para Date
  endAt: z.coerce.date(),
  thumbnailUrl: z.url().optional(),
  maxTicketsPerOrder: z.number().int().min(1).max(10).default(4),
  ageRestriction: z.number().int().min(0).max(21).optional(),
}).refine(
  (data) => data.endAt > data.startAt,
  { message: 'endAt deve ser posterior a startAt', path: ['endAt'] },
);

export type CreateEventDto = z.infer<typeof CreateEventSchema>;

export const EventResponseSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  slug: z.string(),
  status: EventStatusSchema,
  startAt: z.coerce.date(),
  endAt: z.coerce.date(),
  venueName: z.string(),
  venueCity: z.string(),
  venueState: z.string(),
  thumbnailUrl: z.url().nullable(),
  minPrice: z.number().nullable(),
  availableTickets: z.number().int(),
  createdAt: z.coerce.date(),
});

export type EventResponse = z.infer<typeof EventResponseSchema>;

// ─── Ticket Batch ─────────────────────────────────────────────────────────────

export const CreateTicketBatchSchema = z.object({
  eventId: z.uuid(),
  name: z.string().min(2).max(100),   // ex: "Pista", "VIP", "Camarote"
  price: z.number().nonnegative().multipleOf(0.01),
  totalQuantity: z.number().int().positive(),
  saleStartAt: z.coerce.date(),
  saleEndAt: z.coerce.date(),
  sectionId: z.uuid().optional(),
});

export type CreateTicketBatchDto = z.infer<typeof CreateTicketBatchSchema>;
```

---

### Schemas Zod de Reservas e Pagamentos

```typescript
// packages/types/src/bookings.ts

import { z } from 'zod';

export const ReservationStatusSchema = z.enum([
  'pending',    // lock ativo no Redis — aguardando checkout
  'confirmed',  // pagamento confirmado
  'expired',    // TTL do Redis expirou antes do pagamento
  'cancelled',  // comprador cancelou ou pagamento falhou
]);

export const CreateReservationSchema = z.object({
  eventId: z.uuid(),
  items: z.array(
    z.object({
      ticketBatchId: z.uuid(),
      seatId: z.uuid().optional(),
      quantity: z.number().int().min(1).max(10),
    })
  ).min(1).max(10),
});

export type CreateReservationDto = z.infer<typeof CreateReservationSchema>;
```

```typescript
// packages/types/src/payments.ts

import { z } from 'zod';

export const OrderStatusSchema = z.enum([
  'pending',
  'paid',
  'failed',
  'refunded',
  'partially_refunded',
]);

export const CreateOrderSchema = z.object({
  reservationIds: z.array(z.uuid()).min(1),
});

export type CreateOrderDto = z.infer<typeof CreateOrderSchema>;

export const OrderResponseSchema = z.object({
  id: z.uuid(),
  status: OrderStatusSchema,
  total: z.number(),
  checkoutUrl: z.url(),
  expiresAt: z.coerce.date(),
});

export type OrderResponse = z.infer<typeof OrderResponseSchema>;
```

---

### Tópicos Kafka tipados

```typescript
// packages/types/src/kafka-topics.ts
//
// Define todos os tópicos e seus payloads.
// Produtores e consumidores usam esses tipos — sem mensagens mal formadas.

import { z } from 'zod';

// ─── Nomes dos tópicos (constantes) ──────────────────────────────────────────
export const KAFKA_TOPICS = {
  // Booking domain
  RESERVATION_CREATED: 'bookings.reservation-created',
  RESERVATION_EXPIRED: 'bookings.reservation-expired',
  RESERVATION_CANCELLED: 'bookings.reservation-cancelled',

  // Payment domain
  ORDER_CREATED: 'payments.order-created',
  PAYMENT_CONFIRMED: 'payments.payment-confirmed',
  PAYMENT_FAILED: 'payments.payment-failed',
  REFUND_PROCESSED: 'payments.refund-processed',

  // Event domain (CDC via Debezium)
  EVENT_PUBLISHED: 'events.event-published',
  EVENT_UPDATED: 'events.event-updated',
  EVENT_CANCELLED: 'events.event-cancelled',
} as const;

export type KafkaTopic = (typeof KAFKA_TOPICS)[keyof typeof KAFKA_TOPICS];

// ─── Payloads tipados ─────────────────────────────────────────────────────────

export const PaymentConfirmedEventSchema = z.object({
  orderId: z.uuid(),
  buyerId: z.uuid(),
  organizerId: z.uuid(),
  items: z.array(
    z.object({
      reservationId: z.uuid(),
      ticketBatchId: z.uuid(),
      seatId: z.uuid().nullable(),
      unitPrice: z.number(),
    })
  ),
  paidAt: z.coerce.date(),
});

export type PaymentConfirmedEvent = z.infer<typeof PaymentConfirmedEventSchema>;

export const ReservationCreatedEventSchema = z.object({
  reservationId: z.uuid(),
  buyerId: z.uuid(),
  eventId: z.uuid(),
  expiresAt: z.coerce.date(),
  items: z.array(
    z.object({
      ticketBatchId: z.uuid(),
      seatId: z.uuid().nullable(),
      quantity: z.number().int(),
    })
  ),
});

export type ReservationCreatedEvent = z.infer<typeof ReservationCreatedEventSchema>;
```

---

## Passo 2.2 — `packages/kafka` — KafkaModule reutilizável

```typescript
// packages/kafka/src/kafka.module.ts
//
// NestJS module que encapsula o cliente Kafka.
// Cada serviço importa este módulo e usa KafkaProducerService ou
// @EventPattern nos controllers.

import { DynamicModule, Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { KafkaProducerService } from './kafka-producer.service';

export interface KafkaModuleOptions {
  clientId: string;
  brokers: string[];
  groupId: string;
}

@Module({})
export class KafkaModule {
  static forRoot(options: KafkaModuleOptions): DynamicModule {
    return {
      module: KafkaModule,
      imports: [
        ClientsModule.register([
          {
            name: 'KAFKA_CLIENT',
            transport: Transport.KAFKA,
            options: {
              client: {
                clientId: options.clientId,
                brokers: options.brokers,
              },
              consumer: {
                groupId: options.groupId,
                // Não reprocessar mensagens já consumidas ao reiniciar
                allowAutoTopicCreation: false,
              },
              producer: {
                // Garantia de entrega: espera confirmação de todos os replicas
                acks: -1,
                // Retry com backoff exponencial
                retry: { retries: 5 },
              },
            },
          },
        ]),
      ],
      providers: [KafkaProducerService],
      exports: [KafkaProducerService, ClientsModule],
    };
  }
}
```

```typescript
// packages/kafka/src/kafka-producer.service.ts

import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ClientKafka } from '@nestjs/microservices';
import type { KafkaTopic } from '@showpass/types';

@Injectable()
export class KafkaProducerService implements OnModuleInit {
  private readonly logger = new Logger(KafkaProducerService.name);

  constructor(
    @Inject('KAFKA_CLIENT')
    private readonly client: ClientKafka,
  ) {}

  async onModuleInit(): Promise<void> {
    // Conectar ao broker na inicialização do módulo
    await this.client.connect();
    this.logger.log('Kafka producer conectado');
  }

  /**
   * Emite um evento no tópico especificado.
   *
   * @param topic - tópico tipado do KAFKA_TOPICS
   * @param payload - payload validado pelo Zod schema do tópico
   * @param key - chave de particionamento (geralmente o ID do agregado)
   *              Garante que eventos do mesmo agregado vão para a mesma partição
   *              e são processados em ordem
   */
  async emit<T>(topic: KafkaTopic, payload: T, key?: string): Promise<void> {
    const message = {
      key: key ?? null,
      value: JSON.stringify({
        ...payload,
        _meta: {
          topic,
          emittedAt: new Date().toISOString(),
        },
      }),
    };

    await this.client.emit(topic, message).toPromise();

    this.logger.debug(`Evento emitido: ${topic}`, { key });
  }
}
```

---

## Passo 2.3 — `packages/redis` — RedisModule reutilizável

```typescript
// packages/redis/src/redis.module.ts

import { DynamicModule, Module } from '@nestjs/common';
import Redis from 'ioredis';
import { RedisService } from './redis.service';

export interface RedisModuleOptions {
  host: string;
  port: number;
  password?: string;
  db?: number;
}

export const REDIS_CLIENT = 'REDIS_CLIENT';

@Module({})
export class RedisModule {
  static forRoot(options: RedisModuleOptions): DynamicModule {
    const redisProvider = {
      provide: REDIS_CLIENT,
      useFactory: (): Redis => {
        const client = new Redis({
          host: options.host,
          port: options.port,
          password: options.password,
          db: options.db ?? 0,
          // Reconectar automaticamente com backoff exponencial
          retryStrategy: (times) => Math.min(times * 50, 2000),
          // Timeout de conexão: 5s
          connectTimeout: 5000,
          // Manter conexão viva com PING periódico
          keepAlive: 10000,
          // Desabilitar modo legado (usar Promises nativas)
          lazyConnect: false,
        });

        client.on('error', (err) => {
          console.error('[Redis] Erro de conexão:', err);
        });

        return client;
      },
    };

    return {
      module: RedisModule,
      providers: [redisProvider, RedisService],
      exports: [REDIS_CLIENT, RedisService],
      global: true,  // disponível em todos os módulos sem reimportar
    };
  }
}
```

```typescript
// packages/redis/src/redis.service.ts
//
// Abstração sobre o ioredis com métodos utilitários para o ShowPass.
// Inclui suporte a Lua scripts (necessário para operações atômicas).

import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from './redis.module';

@Injectable()
export class RedisService {
  constructor(
    @Inject(REDIS_CLIENT)
    private readonly redis: Redis,
  ) {}

  // ─── Lock distribuído ──────────────────────────────────────────────────────

  /**
   * Tenta adquirir um lock exclusivo.
   *
   * SET key value NX EX ttl
   *
   * NX = "set only if Not eXists" — operação atômica, sem race condition
   * EX = TTL em segundos — lock expira automaticamente (sem deadlock)
   *
   * @returns true se adquiriu o lock, false se já está travado
   */
  async acquireLock(key: string, ownerId: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.redis.set(key, ownerId, 'NX', 'EX', ttlSeconds);
    return result === 'OK';
  }

  /**
   * Libera o lock APENAS se for o dono (ownerId corresponde ao valor).
   *
   * Usa Lua script para garantir atomicidade: o GET e o DEL acontecem
   * na mesma operação — sem race condition entre verificar e deletar.
   */
  async releaseLock(key: string, ownerId: string): Promise<boolean> {
    const luaScript = `
      -- Verificar se o lock pertence ao dono antes de deletar
      if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("DEL", KEYS[1])
      else
        return 0
      end
    `;

    const result = await this.redis.eval(luaScript, 1, key, ownerId) as number;
    return result === 1;
  }

  /**
   * Renova o TTL de um lock existente.
   * Usado quando o checkout demora mais que o esperado.
   */
  async renewLock(key: string, ownerId: string, ttlSeconds: number): Promise<boolean> {
    const luaScript = `
      if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("EXPIRE", KEYS[1], ARGV[2])
      else
        return 0
      end
    `;

    const result = await this.redis.eval(luaScript, 1, key, ownerId, ttlSeconds) as number;
    return result === 1;
  }

  // ─── Cache simples ─────────────────────────────────────────────────────────

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.redis.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const serialized = JSON.stringify(value);
    if (ttlSeconds) {
      await this.redis.setex(key, ttlSeconds, serialized);
    } else {
      await this.redis.set(key, serialized);
    }
  }

  async del(key: string): Promise<void> {
    await this.redis.del(key);
  }

  // ─── Contadores atômicos ───────────────────────────────────────────────────

  /**
   * Decrementa um contador e retorna o novo valor.
   * Usado para controlar ingressos disponíveis por lote.
   */
  async decrementAvailable(key: string, by = 1): Promise<number> {
    return this.redis.decrby(key, by);
  }

  async incrementAvailable(key: string, by = 1): Promise<number> {
    return this.redis.incrby(key, by);
  }
}
```

---

## Passo 2.4 — Prisma por Bounded Context

Cada serviço tem seu próprio `prisma/schema.prisma`. Isso garante que:
- O **event-service** só acessa tabelas de eventos
- O **booking-service** só acessa tabelas de reservas
- Nenhum serviço faz JOIN em tabelas de outro — comunicação via eventos Kafka

### Schema do Event Service

```prisma
// apps/event-service/prisma/schema.prisma

generator client {
  provider = "prisma-client-js"
  output   = "../src/prisma/generated"  // não commitar — gerado no build
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// ─── Plans (SaaS tiers) ───────────────────────────────────────────────────────

model Plan {
  id   String @id @default(uuid()) @db.Uuid
  name String @unique  // "free", "pro", "enterprise"
  slug String @unique

  // Limites e features por plano
  maxActiveEvents  Int
  maxVenues        Int
  serviceFeePercent Decimal  @db.Decimal(5, 2)

  hasAnalytics  Boolean @default(false)
  hasApiAccess  Boolean @default(false)
  hasWhiteLabel Boolean @default(false)

  priceMonthly Decimal @db.Decimal(10, 2)
  isVisible    Boolean @default(true)

  organizers Organizer[]

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@map("plans")
}

// ─── Organizers ───────────────────────────────────────────────────────────────

model Organizer {
  id   String @id @default(uuid()) @db.Uuid
  name String
  slug String @unique

  planId String @db.Uuid
  plan   Plan   @relation(fields: [planId], references: [id])

  stripeCustomerId String? @unique

  planExpiresAt DateTime?
  trialEndsAt   DateTime?

  venues    Venue[]
  events    Event[]
  users     OrganizerUser[]

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@map("organizers")
}

model OrganizerUser {
  id           String    @id @default(uuid()) @db.Uuid
  organizerId  String    @db.Uuid
  organizer    Organizer @relation(fields: [organizerId], references: [id])

  name         String
  email        String    @unique
  passwordHash String
  role         String    @default("member")  // "owner", "admin", "member"

  emailVerifiedAt DateTime?
  lastLoginAt     DateTime?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([organizerId, role])
  @@map("organizer_users")
}

// ─── Venues ────────────────────────────────────────────────────────────────────

model Venue {
  id          String    @id @default(uuid()) @db.Uuid
  organizerId String    @db.Uuid
  organizer   Organizer @relation(fields: [organizerId], references: [id])

  name      String
  address   String
  city      String
  state     String    @db.Char(2)
  zipCode   String    @db.Char(8)
  latitude  Decimal   @db.Decimal(10, 7)
  longitude Decimal   @db.Decimal(10, 7)
  capacity  Int

  sections Section[]
  events   Event[]

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([organizerId])
  @@map("venues")
}

model Section {
  id      String @id @default(uuid()) @db.Uuid
  venueId String @db.Uuid
  venue   Venue  @relation(fields: [venueId], references: [id])

  name        String
  seatingType String  // "reserved" | "general_admission"
  capacity    Int

  seats         Seat[]
  ticketBatches TicketBatch[]

  @@index([venueId])
  @@map("sections")
}

model Seat {
  id        String  @id @default(uuid()) @db.Uuid
  sectionId String  @db.Uuid
  section   Section @relation(fields: [sectionId], references: [id])

  row    String  // "A", "B", ..., "Z"
  number Int     // 1, 2, 3, ...
  type   String  @default("standard")  // "standard", "vip", "accessible"

  // Coordenadas no mapa SVG (para renderização visual)
  mapX Decimal? @db.Decimal(8, 2)
  mapY Decimal? @db.Decimal(8, 2)

  @@unique([sectionId, row, number])
  @@index([sectionId])
  @@map("seats")
}

// ─── Categories ───────────────────────────────────────────────────────────────

model Category {
  id   String @id @default(uuid()) @db.Uuid
  name String @unique
  slug String @unique
  icon String?

  events Event[]

  @@map("categories")
}

// ─── Events ───────────────────────────────────────────────────────────────────

model Event {
  id          String    @id @default(uuid()) @db.Uuid
  organizerId String    @db.Uuid
  organizer   Organizer @relation(fields: [organizerId], references: [id])
  venueId     String    @db.Uuid
  venue       Venue     @relation(fields: [venueId], references: [id])
  categoryId  String    @db.Uuid
  category    Category  @relation(fields: [categoryId], references: [id])

  title       String
  slug        String  @unique
  description String  @db.Text
  status      String  @default("draft")

  startAt DateTime
  endAt   DateTime

  // Colunas desnormalizadas para performance em listagens
  // (evita JOIN com venue a cada query de listagem)
  venueCity  String
  venueState String

  thumbnailUrl String?
  ageRestriction Int?
  maxTicketsPerOrder Int @default(4)

  // Contadores desnormalizados — atualizados via Kafka events
  // Evita COUNT(*) caro a cada request de disponibilidade
  totalCapacity      Int @default(0)
  soldCount          Int @default(0)
  reservedCount      Int @default(0)

  ticketBatches TicketBatch[]

  publishedAt DateTime?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@index([organizerId, status])
  @@index([venueCity, status])
  @@index([startAt, status])
  @@map("events")
}

model TicketBatch {
  id      String @id @default(uuid()) @db.Uuid
  eventId String @db.Uuid
  event   Event  @relation(fields: [eventId], references: [id])

  // Seção específica deste lote (null = evento inteiro)
  sectionId String?  @db.Uuid
  section   Section? @relation(fields: [sectionId], references: [id])

  name           String   // "Pista", "VIP", "Camarote"
  price          Decimal  @db.Decimal(10, 2)
  totalQuantity  Int
  soldCount      Int      @default(0)
  reservedCount  Int      @default(0)

  saleStartAt DateTime
  saleEndAt   DateTime

  isVisible Boolean @default(true)

  @@index([eventId])
  @@map("ticket_batches")
}
```

### Schema do Booking Service

```prisma
// apps/booking-service/prisma/schema.prisma

generator client {
  provider = "prisma-client-js"
  output   = "../src/prisma/generated"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Buyer {
  id           String  @id @default(uuid()) @db.Uuid
  name         String
  email        String  @unique
  passwordHash String
  phone        String?

  emailVerifiedAt DateTime?
  lastLoginAt     DateTime?

  reservations Reservation[]

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@map("buyers")
}

model Reservation {
  id      String @id @default(uuid()) @db.Uuid
  buyerId String @db.Uuid
  buyer   Buyer  @relation(fields: [buyerId], references: [id])

  // IDs de referência para o event-service
  // (não há FK cross-service — integridade via eventos Kafka)
  eventId       String @db.Uuid
  organizerId   String @db.Uuid

  status    String  @default("pending")
  expiresAt DateTime

  orderId String? @db.Uuid  // preenchido quando order é criada

  items ReservationItem[]

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([buyerId, status])
  @@index([eventId, status])
  @@map("reservations")
}

model ReservationItem {
  id            String      @id @default(uuid()) @db.Uuid
  reservationId String      @db.Uuid
  reservation   Reservation @relation(fields: [reservationId], references: [id])

  ticketBatchId String  @db.Uuid
  seatId        String? @db.Uuid  // null para general_admission

  unitPrice Decimal @db.Decimal(10, 2)
  quantity  Int     @default(1)

  @@map("reservation_items")
}
```

### Schema do Payment Service

```prisma
// apps/payment-service/prisma/schema.prisma

generator client {
  provider = "prisma-client-js"
  output   = "../src/prisma/generated"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Order {
  id String @id @default(uuid()) @db.Uuid

  // Referências cross-service (sem FK — integridade via eventos)
  buyerId     String @db.Uuid
  eventId     String @db.Uuid
  organizerId String @db.Uuid

  status String @default("pending")

  subtotal   Decimal @db.Decimal(10, 2)
  serviceFee Decimal @db.Decimal(10, 2)
  total      Decimal @db.Decimal(10, 2)

  // Stripe
  stripePaymentIntentId   String? @unique
  stripeCheckoutSessionId String? @unique
  stripeChargeId          String?

  // Idempotency key: hash dos reservation IDs
  // Protege contra dupla cobrança em retries
  idempotencyKey String @unique

  paymentMethod  String? // "card", "pix"
  cardLastFour   String? @db.Char(4)
  cardBrand      String?

  paidAt     DateTime?
  refundedAt DateTime?

  items OrderItem[]

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([buyerId, status])
  @@index([organizerId, status])
  @@map("orders")
}

model OrderItem {
  id      String @id @default(uuid()) @db.Uuid
  orderId String @db.Uuid
  order   Order  @relation(fields: [orderId], references: [id])

  reservationId String @db.Uuid
  ticketBatchId String @db.Uuid
  seatId        String? @db.Uuid

  // Snapshot do preço no momento da compra
  // (o preço pode mudar depois — o ingresso vale o valor pago)
  unitPrice Decimal @db.Decimal(10, 2)
  quantity  Int     @default(1)
  total     Decimal @db.Decimal(10, 2)

  @@map("order_items")
}
```

---

## Passo 2.5 — PrismaService (padrão por serviço)

```typescript
// apps/event-service/src/prisma/prisma.service.ts
//
// Wrapper do PrismaClient com lifecycle hooks do NestJS.
// Cada serviço tem sua própria instância — databases separados.
//
// Prisma 7: $on() agora tem tipagem completa — sem casts para `any`.

import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { PrismaClient, Prisma } from './generated';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      log: process.env.NODE_ENV === 'development'
        ? [
            { emit: 'event', level: 'query' },   // logar queries em dev
            { emit: 'stdout', level: 'warn' },
            { emit: 'stdout', level: 'error' },
          ]
        : [
            { emit: 'stdout', level: 'error' },
          ],
    });
  }

  async onModuleInit(): Promise<void> {
    // Conectar ao banco na inicialização
    // NestJS garante que isso ocorre antes de qualquer request
    await this.$connect();
    this.logger.log('Prisma conectado ao banco de dados');

    // Em desenvolvimento, logar queries lentas (N+1, missing indexes)
    // Prisma 7: $on() tem tipagem completa via Prisma.QueryEvent
    if (process.env.NODE_ENV === 'development') {
      this.$on('query', (e: Prisma.QueryEvent) => {
        if (e.duration > 100) {
          this.logger.warn(`Slow query (${e.duration}ms): ${e.query}`);
        }
      });
    }
  }
}
```

---

## Passo 2.6 — Read-Replica com Prisma

> **Por que Read-Replica?**  
> A razão leitura:escrita é 100:1. Para cada organizer que cria um evento, existem ~100 compradores lendo.  
> O primary PostgreSQL fica livre para **escritas críticas** (reservas, pagamentos).  
> A read-replica serve todas as **leituras** (listagem de eventos, páginas públicas, dashboard).

```
PostgreSQL Primary  ──── replicação síncrona ────► PostgreSQL Read-Replica
  (escritas)                                          (leituras — somente SELECT)
  INSERT, UPDATE                                      Event Service reads
  DELETE, DDL                                         Search Service indexer fallback
  Reservas, Pagamentos                                Dashboard queries
```

```typescript
// apps/event-service/src/prisma/prisma.service.ts
//
// Prisma 7 + @prisma/extension-read-replicas
// O Prisma roteia automaticamente:
//   - prisma.$transaction() → Primary (escrita)
//   - prisma.event.findMany() → Read-Replica (leitura)
//   - prisma.event.create()  → Primary (escrita)

import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { PrismaClient, Prisma } from './generated';
import { readReplicas } from '@prisma/extension-read-replicas';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  private readonly logger = new Logger(PrismaService.name);

  // Cliente com suporte a read-replica
  // Queries de leitura vão para DATABASE_REPLICA_URL automaticamente
  // Queries de escrita (create, update, delete, $transaction) vão para DATABASE_URL
  readonly db: ReturnType<typeof this._buildExtendedClient>;

  constructor() {
    super({
      log: process.env.NODE_ENV === 'development'
        ? [{ emit: 'event', level: 'query' }, { emit: 'stdout', level: 'warn' }]
        : [{ emit: 'stdout', level: 'error' }],
    });

    // Ativar extension de read-replica apenas se DATABASE_REPLICA_URL estiver configurado
    // Em desenvolvimento (sem replica), usa o primary para tudo
    this.db = this._buildExtendedClient();
  }

  private _buildExtendedClient() {
    const replicaUrl = process.env.DATABASE_REPLICA_URL;

    if (replicaUrl) {
      return (this as PrismaClient).$extends(
        readReplicas({ url: replicaUrl }),
      );
    }

    // Sem replica configurada → usar primary para tudo (dev/staging)
    return this as PrismaClient;
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log(
      process.env.DATABASE_REPLICA_URL
        ? 'Prisma conectado — Primary + Read-Replica ativos'
        : 'Prisma conectado — Primary only (sem read-replica)',
    );

    if (process.env.NODE_ENV === 'development') {
      this.$on('query', (e: Prisma.QueryEvent) => {
        if (e.duration > 100) {
          this.logger.warn(`Slow query (${e.duration}ms): ${e.query}`);
        }
      });
    }
  }
}
```

```bash
# apps/event-service/.env
DATABASE_URL="postgresql://event_svc:pass@primary-host:5432/showpass_events"
DATABASE_REPLICA_URL="postgresql://event_svc:pass@replica-host:5432/showpass_events"

# Em desenvolvimento (sem replica): deixar DATABASE_REPLICA_URL vazia ou ausente
# O PrismaService detecta e usa apenas o primary
```

```json
// apps/event-service/package.json — adicionar a extension
{
  "dependencies": {
    "@prisma/extension-read-replicas": "^0.5.0"
  }
}
```

---

## Recapitulando

1. **`packages/types`** com Zod: tipos e validações compartilhados entre frontend e todos os serviços backend — uma única fonte de verdade
2. **Kafka topics tipados**: impossível emitir um evento com payload errado
3. **`packages/kafka`** e **`packages/redis`**: módulos NestJS reutilizáveis, importados em qualquer serviço com `KafkaModule.forRoot(config)`
4. **Prisma por bounded context**: cada serviço acessa apenas seu próprio schema — acoplamento zero entre serviços no nível de dados
5. **Colunas desnormalizadas** em `Event` (`venueCity`, `venueState`, `soldCount`): evitam JOINs caros em queries de alta frequência
6. **Read-Replica** via `@prisma/extension-read-replicas` — leituras vão para a replica; escritas ficam no primary; sem mudança de código nos serviços

---

## Próximo capítulo

[Capítulo 3 → API Gateway](cap-03-api-gateway.md)
