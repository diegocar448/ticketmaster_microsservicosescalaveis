# Capítulo 7 — Payment Service

> **Objetivo:** Integrar o Stripe com Checkout Session, `Idempotency Keys` para evitar cobranças duplicadas e validação HMAC nos webhooks — o único ponto que pode confirmar pagamentos.

## O que você vai aprender

- Stripe Checkout Session vs Payment Intents — quando usar cada um
- `Idempotency Keys`: mesmo retry = mesma cobrança, sem duplicar
- Webhook HMAC (OWASP A10): apenas o Stripe pode confirmar pagamentos
- Idempotência no processamento: reenvio do Stripe não processa duas vezes
- Bounded context replication: por que o payment-service tem réplicas de `Plan`, `Organizer` e `Buyer`
- NestJS Hybrid App: HTTP (webhook + orders) + Kafka microservice no mesmo processo

---

## Antes de começar — HTTP ou Kafka?

O payment-service precisa de três dados do restante da plataforma para criar uma Checkout Session:

1. **Dados da reserva** (`Reservation` + `ReservationItem`) — owned pelo booking-service
2. **`serviceFeePercent`** do plano do organizer — owned pelo event-service (que também replica)
3. **`email` do comprador** — owned pelo auth-service

Poderíamos resolver tudo via HTTP cross-service. Não fazemos porque:

| Dado | Estratégia | Por quê |
|---|---|---|
| `Reservation` | HTTP síncrono para booking-service | Mudança rápida (criada segundos antes), precisa de **read-your-write** — Kafka é eventually consistent, e uma reserva recém-criada pode não ter chegado ainda |
| `Plan` + `Organizer` | Réplica local via Kafka | Dados estáveis (plano do organizer muda raramente); consultar event-service a cada checkout é acoplamento desnecessário |
| `Buyer.email` | Réplica local via Kafka | Mesmo argumento: `buyers.created` já chega de graça no tópico que o booking consome |

O padrão é o mesmo que vimos no [Capítulo 6](cap-06-booking-service.md): **HTTP quando precisa de freshness, Kafka quando o dado é estável.**

---

## Passo 7.1 — Schema do Prisma

O schema reflete o desenho acima: três modelos replicados + dois owned.

```prisma
// apps/payment-service/prisma/schema.prisma

generator client {
  provider = "prisma-client-js"
  output   = "../src/prisma/generated"
}

datasource db {
  provider = "postgresql"
  // Prisma 7: url foi movida para prisma.config.ts (defineConfig)
}

// ─── Plans (replicados — tabela seedada, fonte da verdade é event-service) ───
//
// Mantemos Plan aqui para evitar um round-trip HTTP ao event-service a cada
// checkout só para pegar serviceFeePercent. Os slugs (free/pro/enterprise) são
// estáveis entre os bancos; UUIDs diferem (cada DB gera o seu no seed).
model Plan {
  id                String  @id @default(uuid()) @db.Uuid
  slug              String  @unique // "free" | "pro" | "enterprise"
  name              String
  serviceFeePercent Decimal @db.Decimal(5, 2)

  organizers Organizer[]

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@map("plans")
}

// ─── Organizers (replicados do auth-service via Kafka) ────────────────────────
//
// Mesma semântica da réplica em event-service: só campos não-sensíveis. Existe
// aqui só para resolver serviceFeePercent no ato do checkout (via Plan).
model Organizer {
  id   String @id @db.Uuid // id vem do auth-service — sem @default
  name String
  slug String @unique

  planId String @db.Uuid
  plan   Plan   @relation(fields: [planId], references: [id])

  lastSyncAt DateTime?

  orders Order[]

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@map("organizers")
}

// ─── Buyers (replicados do auth-service via Kafka) ────────────────────────────
//
// Existe aqui porque o Stripe Checkout exige customer_email no ato da sessão.
// Chamar auth-service a cada checkout seria acoplamento desnecessário: o email
// já chega de graça via o mesmo tópico Kafka que o booking consome.
model Buyer {
  id    String  @id @db.Uuid
  email String  @unique
  name  String?

  lastSyncAt DateTime?

  orders Order[]

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@map("buyers")
}

// ─── Orders (pedidos de pagamento — owned pelo payment-service) ───────────────

model Order {
  id String @id @default(uuid()) @db.Uuid

  buyer       Buyer     @relation(fields: [buyerId], references: [id])
  buyerId     String    @db.Uuid
  organizer   Organizer @relation(fields: [organizerId], references: [id])
  organizerId String    @db.Uuid

  // eventId é opaco aqui (FK lógica com event-service — sem constraint)
  eventId String @db.Uuid

  status String @default("pending") // pending | paid | failed | refunded | partially_refunded

  subtotal   Decimal @db.Decimal(10, 2)
  serviceFee Decimal @db.Decimal(10, 2)
  total      Decimal @db.Decimal(10, 2)

  // Stripe
  stripePaymentIntentId   String? @unique
  stripeCheckoutSessionId String? @unique
  stripeChargeId          String?

  // Idempotency key: hash determinístico dos reservation IDs + buyer.
  // Mesmo conjunto de reservas + mesmo buyer = mesma Checkout Session.
  // Protege contra retries, double-click, reenvio acidental.
  idempotencyKey String @unique

  paymentMethod String? // "card", "pix"
  cardLastFour  String? @db.Char(4)
  cardBrand     String?

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

  reservationId String  @db.Uuid
  ticketBatchId String  @db.Uuid
  seatId        String? @db.Uuid

  // Snapshot do preço no momento da compra
  // (o preço do batch pode mudar depois — o ingresso vale o valor pago)
  unitPrice Decimal @db.Decimal(10, 2)
  quantity  Int     @default(1)
  total     Decimal @db.Decimal(10, 2)

  @@map("order_items")
}
```

Rodar a migration:

```bash
pnpm --filter @showpass/payment-service run db:generate
pnpm --filter @showpass/payment-service run db:migrate -- --name add_replicas_and_orders
```

---

## Passo 7.2 — `main.ts` híbrido (HTTP + Kafka) e PrismaService

O payment-service é **hybrid app**: expõe HTTP (para `/payments/orders` e `/webhooks/stripe`) e consome Kafka (para `auth.buyer.*` e `auth.organizer.*`). A pegadinha: **Stripe exige raw body** para validar HMAC.

```typescript
// apps/payment-service/src/main.ts

import 'dotenv/config';
import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import bodyParser from 'body-parser';

import { AppModule } from './app.module.js';

async function bootstrap(): Promise<void> {
  // rawBody: true é CRÍTICO — habilita req.rawBody no controller do webhook.
  // Sem isso, o parser JSON consome o body e a validação HMAC falha
  // (o Stripe assina os bytes originais, não o JSON re-serializado).
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });

  // JSON parser global para as outras rotas. Como rawBody: true preserva o
  // buffer bruto via req.rawBody, podemos parsear normalmente aqui.
  app.use(bodyParser.json({ limit: '10mb' }));

  // ─── Kafka microservice (consumers) ───────────────────────────────────────
  // Conectamos o transport Kafka para que @EventPattern rode no mesmo processo.
  // Um groupId dedicado evita que o consumer "roube" mensagens do producer.
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.KAFKA,
    options: {
      client: {
        clientId: process.env.KAFKA_CLIENT_ID ?? 'payment-service',
        brokers: (process.env.KAFKA_BROKERS ?? 'localhost:29092').split(','),
      },
      consumer: {
        groupId: process.env.KAFKA_CONSUMER_GROUP_ID ?? 'payment-service-consumer',
        allowAutoTopicCreation: false,
      },
    },
  });

  await app.startAllMicroservices();
  await app.listen(process.env.PORT ?? 3002);
}

void bootstrap();
```

O `PrismaService` segue o padrão dos capítulos anteriores (Prisma 7 + `@prisma/adapter-pg`), idêntico ao `apps/booking-service/src/prisma/prisma.service.ts`. Não repito aqui.

---

## Passo 7.3 — Consumers de `Buyer` e `Organizer`

Mesmo padrão dos consumers do event-service (Capítulo 5) e booking-service (Capítulo 6): `@EventPattern` + Zod `safeParse` + `upsert` idempotente.

```typescript
// apps/payment-service/src/modules/buyers/buyers.consumer.ts

import { Controller, Logger } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { KAFKA_TOPICS, BuyerCreatedEventSchema, BuyerUpdatedEventSchema } from '@showpass/types';
import { PrismaService } from '../../prisma/prisma.service.js';

@Controller()
export class BuyersConsumer {
  private readonly logger = new Logger(BuyersConsumer.name);

  constructor(private readonly prisma: PrismaService) {}

  @EventPattern(KAFKA_TOPICS.AUTH_BUYER_CREATED)
  async onCreated(@Payload() message: unknown): Promise<void> {
    const parsed = BuyerCreatedEventSchema.safeParse(message);
    if (!parsed.success) {
      this.logger.warn('auth.buyer.created inválido', { issues: parsed.error.issues });
      return;
    }

    const { id, email, name } = parsed.data;

    // upsert é idempotente — retries do Kafka não quebram nada
    await this.prisma.buyer.upsert({
      where: { id },
      create: { id, email, name, lastSyncAt: new Date() },
      update: { email, name, lastSyncAt: new Date() },
    });
  }

  @EventPattern(KAFKA_TOPICS.AUTH_BUYER_UPDATED)
  async onUpdated(@Payload() message: unknown): Promise<void> {
    const parsed = BuyerUpdatedEventSchema.safeParse(message);
    if (!parsed.success) return;

    const { id, email, name } = parsed.data;
    await this.prisma.buyer.upsert({
      where: { id },
      create: { id, email, name, lastSyncAt: new Date() },
      update: { email, name, lastSyncAt: new Date() },
    });
  }
}
```

```typescript
// apps/payment-service/src/modules/organizers/organizers.consumer.ts

import { Controller, Logger } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import {
  KAFKA_TOPICS,
  OrganizerCreatedEventSchema,
  OrganizerUpdatedEventSchema,
} from '@showpass/types';
import { PrismaService } from '../../prisma/prisma.service.js';

@Controller()
export class OrganizersConsumer {
  private readonly logger = new Logger(OrganizersConsumer.name);

  constructor(private readonly prisma: PrismaService) {}

  @EventPattern(KAFKA_TOPICS.AUTH_ORGANIZER_CREATED)
  async onCreated(@Payload() message: unknown): Promise<void> {
    const parsed = OrganizerCreatedEventSchema.safeParse(message);
    if (!parsed.success) {
      this.logger.warn('auth.organizer.created inválido', { issues: parsed.error.issues });
      return;
    }

    const { id, name, slug, planSlug } = parsed.data;

    // planSlug → planId: os UUIDs diferem entre bancos (cada DB seedou o seu),
    // mas o slug é estável. Por isso o evento carrega planSlug, não planId.
    const plan = await this.prisma.plan.findUnique({ where: { slug: planSlug } });
    if (!plan) {
      this.logger.error('plano inexistente no payment-service', { planSlug });
      return;
    }

    await this.prisma.organizer.upsert({
      where: { id },
      create: { id, name, slug, planId: plan.id, lastSyncAt: new Date() },
      update: { name, slug, planId: plan.id, lastSyncAt: new Date() },
    });
  }

  @EventPattern(KAFKA_TOPICS.AUTH_ORGANIZER_UPDATED)
  async onUpdated(@Payload() message: unknown): Promise<void> {
    const parsed = OrganizerUpdatedEventSchema.safeParse(message);
    if (!parsed.success) return;

    const { id, name, slug, planSlug } = parsed.data;
    const plan = await this.prisma.plan.findUnique({ where: { slug: planSlug } });
    if (!plan) return;

    await this.prisma.organizer.upsert({
      where: { id },
      create: { id, name, slug, planId: plan.id, lastSyncAt: new Date() },
      update: { name, slug, planId: plan.id, lastSyncAt: new Date() },
    });
  }
}
```

---

## Passo 7.4 — `OrdersService` (Checkout Session + Idempotency Key)

A peça central. Resolve reservas via HTTP (read-your-write), calcula taxa a partir da réplica local e cria a Stripe Checkout Session.

```typescript
// apps/payment-service/src/modules/orders/orders.service.ts

import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import Stripe from 'stripe';

import { KafkaProducerService } from '@showpass/kafka';
import { KAFKA_TOPICS } from '@showpass/types';
import { PrismaService } from '../../prisma/prisma.service.js';

// O Stripe 22 reorganizou as re-exportações: Stripe.Checkout.SessionCreateParams.LineItem
// deixou de existir como tipo exportado. Derivamos o tipo a partir da assinatura
// do método create() — a forma oficial recomendada no CHANGELOG.
type StripeLineItem = NonNullable<
  Parameters<Stripe['checkout']['sessions']['create']>[0]
>['line_items'] extends Array<infer L> | undefined ? L : never;

interface ReservationItem {
  ticketBatchId: string;
  ticketBatchName: string;
  seatId: string | null;
  seatLabel: string | null;
  unitPrice: string; // Decimal vem como string do JSON
  quantity: number;
  eventTitle: string;
  thumbnailUrl?: string | null;
}

interface Reservation {
  id: string;
  buyerId: string;
  organizerId: string;
  eventId: string;
  status: string;
  items: ReservationItem[];
}

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  private readonly stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
    // Omitir apiVersion faz o SDK usar a versão "pinned" do build (22.x).
    // Evita drift entre SDK e API surface.
  });

  constructor(
    private readonly prisma: PrismaService,
    private readonly kafka: KafkaProducerService,
  ) {}

  /**
   * Cria um Pedido + Stripe Checkout Session.
   *
   * Idempotency Key: hash SHA-256 de (buyerId + reservationIds ordenados).
   * Mesmo conjunto = mesma key = mesma session (tanto no DB quanto no Stripe).
   */
  async createCheckout(
    buyerId: string,
    reservationIds: string[],
    authHeaders: Record<string, string>,
  ): Promise<{ orderId: string; checkoutUrl: string; status: string }> {
    // ─── 1. Carregar reservas do booking-service (HTTP — read-your-write) ──────
    const reservations = await this.fetchReservations(reservationIds, authHeaders);

    // ─── 2. Validar: todas pertencem ao buyer e estão pendentes ────────────────
    for (const r of reservations) {
      if (r.buyerId !== buyerId) {
        throw new BadRequestException('Reserva não pertence ao comprador');
      }
      if (r.status !== 'pending') {
        throw new BadRequestException(`Reserva ${r.id} não está pendente`);
      }
    }

    // ─── 3. Totais ─────────────────────────────────────────────────────────────
    const organizerId = reservations[0].organizerId;
    const eventId = reservations[0].eventId;

    const subtotal = reservations.reduce(
      (s, r) =>
        s + r.items.reduce((si, i) => si + Number(i.unitPrice) * i.quantity, 0),
      0,
    );

    // Taxa de serviço vem da réplica local (Organizer → Plan)
    const feePct = await this.getServiceFeePercent(organizerId);
    const serviceFee = Math.round(subtotal * (feePct / 100) * 100) / 100;
    const total = subtotal + serviceFee;

    // ─── 4. Idempotency Key ────────────────────────────────────────────────────
    const idempotencyKey = createHash('sha256')
      .update(`${buyerId}:${[...reservationIds].sort().join(',')}`)
      .digest('hex');

    // Se o Order já existe COM session, devolver sem nova cobrança
    const existing = await this.prisma.order.findUnique({ where: { idempotencyKey } });
    if (existing?.stripeCheckoutSessionId) {
      const session = await this.stripe.checkout.sessions.retrieve(
        existing.stripeCheckoutSessionId,
      );
      return {
        orderId: existing.id,
        checkoutUrl: session.url ?? '',
        status: existing.status,
      };
    }

    // ─── 5. Criar Order (pending) — ou retomar órfão ──────────────────────────
    // Caso de retomada: um POST anterior criou o Order mas a chamada ao Stripe
    // falhou (rede/chave inválida/timeout). O UNIQUE de idempotencyKey impede
    // recriar; então reusamos o Order pendente e seguimos para (re)criar a Session.
    // Sem esse ramo, retries legítimos do cliente explodiam com UniqueConstraintViolation.
    const order =
      existing ??
      (await this.prisma.order.create({
        data: {
          buyerId,
          organizerId,
          eventId,
          status: 'pending',
          subtotal,
          serviceFee,
          total,
          idempotencyKey,
          items: {
            create: reservations.flatMap((r) =>
              r.items.map((i) => ({
                reservationId: r.id,
                ticketBatchId: i.ticketBatchId,
                seatId: i.seatId,
                unitPrice: i.unitPrice,
                quantity: i.quantity,
                total: Number(i.unitPrice) * i.quantity,
              })),
            ),
          },
        },
      }));

    // ─── 6. Criar Stripe Checkout Session ─────────────────────────────────────
    const buyer = await this.prisma.buyer.findUnique({ where: { id: buyerId } });
    if (!buyer) {
      // Improvável: o Kafka já replicou, ou a request falha no BuyerGuard antes.
      throw new NotFoundException('Comprador não encontrado na réplica local');
    }

    const lineItems = this.buildLineItems(reservations, serviceFee);

    const session = await this.stripe.checkout.sessions.create(
      {
        mode: 'payment',
        payment_method_types: ['card'],
        customer_email: buyer.email,
        line_items: lineItems,
        success_url: `${process.env.FRONTEND_URL}/checkout/success?order=${order.id}`,
        cancel_url: `${process.env.FRONTEND_URL}/checkout/cancel?order=${order.id}`,
        // Expira 30 min: dá folga para o comprador sem prender o lock Redis
        // (que em booking-service é de 15 min — o lock some antes da session)
        expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
        metadata: {
          order_id: order.id,
          buyer_id: buyerId,
          event_id: eventId,
        },
        payment_intent_data: {
          metadata: {
            order_id: order.id,
            buyer_id: buyerId,
          },
        },
      },
      {
        // Idempotency no próprio Stripe — mesma key = mesma session do lado deles
        idempotencyKey,
      },
    );

    await this.prisma.order.update({
      where: { id: order.id },
      data: {
        stripeCheckoutSessionId: session.id,
        stripePaymentIntentId:
          typeof session.payment_intent === 'string' ? session.payment_intent : null,
      },
    });

    // Emitir order.created best-effort — consumidores que queiram reagir podem
    await this.kafka
      .emit(
        KAFKA_TOPICS.ORDER_CREATED,
        { orderId: order.id, buyerId, organizerId, eventId, total },
        order.id,
      )
      .catch((err) =>
        this.logger.warn('Falha ao emitir order.created (best-effort)', {
          error: (err as Error).message,
        }),
      );

    this.logger.log('Checkout criado', { orderId: order.id, sessionId: session.id });

    return {
      orderId: order.id,
      checkoutUrl: session.url ?? '',
      status: 'pending',
    };
  }

  /**
   * Retorna o pedido — 404 (não 403) se não pertencer ao buyer.
   * OWASP A01: 403 revela que o recurso existe (IDOR probing).
   */
  async getOrder(orderId: string, buyerId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });
    if (!order || order.buyerId !== buyerId) {
      throw new NotFoundException('Pedido não encontrado');
    }
    return order;
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private buildLineItems(reservations: Reservation[], serviceFee: number): StripeLineItem[] {
    const items: StripeLineItem[] = [];

    for (const r of reservations) {
      for (const item of r.items) {
        items.push({
          quantity: item.quantity,
          price_data: {
            currency: 'brl',
            unit_amount: Math.round(Number(item.unitPrice) * 100), // centavos
            product_data: {
              name: item.eventTitle,
              description: item.seatLabel
                ? `${item.ticketBatchName} • ${item.seatLabel}`
                : item.ticketBatchName,
              images: item.thumbnailUrl ? [item.thumbnailUrl] : [],
            },
          },
        });
      }
    }

    if (serviceFee > 0) {
      items.push({
        quantity: 1,
        price_data: {
          currency: 'brl',
          unit_amount: Math.round(serviceFee * 100),
          product_data: { name: 'Taxa de serviço ShowPass' },
        },
      });
    }

    return items;
  }

  /**
   * Busca reservas no booking-service. Repassa os headers de auth do usuário
   * para que o BuyerGuard do booking também valide — evita IDOR cross-service.
   */
  private async fetchReservations(
    ids: string[],
    authHeaders: Record<string, string>,
  ): Promise<Reservation[]> {
    const base = process.env.BOOKING_SERVICE_URL ?? 'http://localhost:3004';

    const results = await Promise.all(
      ids.map(async (id) => {
        const res = await fetch(`${base}/bookings/reservations/${id}`, {
          headers: authHeaders,
        });
        if (!res.ok) {
          throw new BadRequestException(`Reserva ${id} inacessível (${res.status})`);
        }
        return (await res.json()) as Reservation;
      }),
    );

    return results;
  }

  private async getServiceFeePercent(organizerId: string): Promise<number> {
    const organizer = await this.prisma.organizer.findUnique({
      where: { id: organizerId },
      include: { plan: true },
    });
    if (!organizer) {
      // Kafka é eventually consistent — pode ter atraso na propagação
      throw new NotFoundException('Organizador não encontrado na réplica local');
    }
    return Number(organizer.plan.serviceFeePercent);
  }
}
```

---

## Passo 7.5 — `OrdersController` (POST `/payments/orders`)

```typescript
// apps/payment-service/src/modules/orders/orders.controller.ts

import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Req,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import type { Request } from 'express';

import { OrdersService } from './orders.service.js';
import { BuyerGuard } from '../../common/guards/buyer.guard.js';
import { CurrentUser, AuthenticatedUser } from '../../common/decorators/current-user.decorator.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { CreateOrderSchema, CreateOrderDto } from './dto/create-order.dto.js';

@Controller('payments/orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  @UseGuards(BuyerGuard)
  async create(
    @Body(new ZodValidationPipe(CreateOrderSchema)) dto: CreateOrderDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    // Repassa os headers x-user-* do gateway para o booking-service validar
    // a reserva também (defesa em profundidade — não confiamos só no gateway)
    const authHeaders: Record<string, string> = {
      'x-user-id': String(req.headers['x-user-id'] ?? ''),
      'x-user-type': String(req.headers['x-user-type'] ?? ''),
      'x-user-email': String(req.headers['x-user-email'] ?? ''),
    };

    return this.orders.createCheckout(user.id, dto.reservationIds, authHeaders);
  }

  @Get(':id')
  @UseGuards(BuyerGuard)
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.orders.getOrder(id, user.id);
  }
}
```

O `BuyerGuard`, o `CurrentUser` decorator e o `ZodValidationPipe` são cópias literais dos que criamos no [Capítulo 6](cap-06-booking-service.md) — não há razão para abstrair prematuramente em um pacote compartilhado.

---

## Passo 7.6 — `WebhooksController` (o único ponto que confirma pagamento)

```typescript
// apps/payment-service/src/modules/webhooks/webhooks.controller.ts

import {
  Controller,
  Post,
  Req,
  HttpCode,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import Stripe from 'stripe';

import { KafkaProducerService } from '@showpass/kafka';
import { KAFKA_TOPICS } from '@showpass/types';
import { PrismaService } from '../../prisma/prisma.service.js';

@Controller('webhooks')
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  private readonly stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
  private readonly webhookSecret = process.env.STRIPE_WEBHOOK_SECRET!;

  constructor(
    private readonly prisma: PrismaService,
    private readonly kafka: KafkaProducerService,
  ) {}

  /**
   * OWASP A10 (Server-Side Request Forgery / Webhook Security):
   * Validamos a assinatura HMAC-SHA256 ANTES de qualquer outra coisa.
   * Sem isso, qualquer pessoa poderia POSTar para /webhooks/stripe e
   * "confirmar" pagamentos falsos.
   *
   * O Stripe SDK também checa o timestamp (rejeita eventos > 5 min —
   * previne replay attacks).
   */
  @Post('stripe')
  @HttpCode(200)
  async handle(@Req() req: RawBodyRequest<Request>): Promise<{ received: boolean }> {
    const signature = req.headers['stripe-signature'];
    if (!signature || typeof signature !== 'string') {
      throw new BadRequestException('Assinatura ausente');
    }
    if (!req.rawBody) {
      // Fail-fast explícito: se alguém remover rawBody: true no main.ts,
      // o erro aparece aqui em vez de silenciosamente aceitar tudo
      throw new BadRequestException('rawBody ausente — checar main.ts');
    }

    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(
        req.rawBody,
        signature,
        this.webhookSecret,
      );
    } catch (err) {
      this.logger.warn('Assinatura Stripe inválida', {
        error: (err as Error).message,
        ip: req.ip,
      });
      throw new BadRequestException('Assinatura inválida');
    }

    this.logger.log(`Webhook recebido: ${event.type}`, { eventId: event.id });

    switch (event.type) {
      case 'checkout.session.completed':
        // Escolhemos checkout.session.completed (e não payment_intent.succeeded)
        // porque a session carrega nosso metadata.order_id de forma estável.
        // O payment_intent também teria, mas exige um fetch extra.
        await this.handleSessionCompleted(event.data.object);
        break;

      case 'payment_intent.payment_failed':
        await this.handlePaymentFailed(event.data.object);
        break;

      case 'checkout.session.expired':
        await this.handleCheckoutExpired(event.data.object);
        break;

      case 'charge.refunded':
        await this.handleRefunded(event.data.object);
        break;

      default:
        this.logger.debug(`Evento ignorado: ${event.type}`);
    }

    return { received: true };
  }

  private async handleSessionCompleted(session: Stripe.Checkout.Session): Promise<void> {
    const orderId = session.metadata?.order_id;
    if (!orderId) return;

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });
    if (!order) {
      this.logger.error('Pedido não encontrado no webhook', { orderId });
      return;
    }

    // IDEMPOTÊNCIA no processamento: o Stripe pode reentregar o mesmo evento.
    // Checar status === 'paid' antes de qualquer update é o jeito mais simples
    // (não precisa de tabela de "eventos processados" para o nosso volume).
    if (order.status === 'paid') {
      this.logger.log('Webhook ignorado: pedido já pago', { orderId });
      return;
    }

    // Buscar detalhes do pagamento
    const paymentIntentId =
      typeof session.payment_intent === 'string' ? session.payment_intent : null;
    const paymentIntent = paymentIntentId
      ? await this.stripe.paymentIntents.retrieve(paymentIntentId, {
          expand: ['latest_charge'],
        })
      : null;

    const charge = paymentIntent?.latest_charge as Stripe.Charge | null;

    await this.prisma.order.update({
      where: { id: orderId },
      data: {
        status: 'paid',
        stripeChargeId: charge?.id,
        paymentMethod: charge?.payment_method_details?.type ?? 'card',
        cardLastFour: charge?.payment_method_details?.card?.last4,
        cardBrand: charge?.payment_method_details?.card?.brand,
        paidAt: new Date(),
      },
    });

    // worker-service escuta payment.confirmed, gera ingressos e envia email
    await this.kafka.emit(
      KAFKA_TOPICS.PAYMENT_CONFIRMED,
      {
        orderId: order.id,
        buyerId: order.buyerId,
        organizerId: order.organizerId,
        eventId: order.eventId,
        items: order.items.map((i) => ({
          reservationId: i.reservationId,
          ticketBatchId: i.ticketBatchId,
          seatId: i.seatId,
          unitPrice: Number(i.unitPrice),
          quantity: i.quantity,
        })),
        paidAt: new Date().toISOString(),
      },
      orderId,
    );

    this.logger.log('Pagamento confirmado', { orderId, total: Number(order.total) });
  }

  private async handlePaymentFailed(paymentIntent: Stripe.PaymentIntent): Promise<void> {
    const orderId = paymentIntent.metadata?.order_id;
    if (!orderId) return;

    const order = await this.prisma.order.findFirst({
      where: { id: orderId, status: 'pending' },
    });
    if (!order) return;

    await this.prisma.order.update({
      where: { id: orderId },
      data: { status: 'failed' },
    });

    await this.kafka.emit(
      KAFKA_TOPICS.PAYMENT_FAILED,
      { orderId, buyerId: order.buyerId, reason: 'payment_failed' },
      orderId,
    );
  }

  private async handleCheckoutExpired(session: Stripe.Checkout.Session): Promise<void> {
    const orderId = session.metadata?.order_id;
    if (!orderId) return;

    const order = await this.prisma.order.findFirst({
      where: { id: orderId, status: 'pending' },
    });
    if (!order) return;

    await this.prisma.order.update({
      where: { id: orderId },
      data: { status: 'failed' },
    });

    await this.kafka.emit(
      KAFKA_TOPICS.PAYMENT_FAILED,
      { orderId, buyerId: order.buyerId, reason: 'checkout_expired' },
      orderId,
    );
  }

  private async handleRefunded(charge: Stripe.Charge): Promise<void> {
    const orderId = charge.metadata?.order_id;
    if (!orderId) return;

    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) return;

    const isFullRefund = charge.amount_refunded === charge.amount;

    await this.prisma.order.update({
      where: { id: orderId },
      data: {
        status: isFullRefund ? 'refunded' : 'partially_refunded',
        refundedAt: new Date(),
      },
    });

    await this.kafka.emit(
      KAFKA_TOPICS.REFUND_PROCESSED,
      { orderId, buyerId: order.buyerId, isFullRefund },
      orderId,
    );
  }
}
```

---

## Passo 7.7 — O endpoint `GET /bookings/reservations/:id` no booking-service

O `OrdersService` faz `GET /bookings/reservations/:id` para cada reservation ID. Esse endpoint precisa existir no booking-service, e com `BuyerGuard` aplicado — IDOR cross-service não pode acontecer.

```typescript
// apps/booking-service/src/modules/reservations/reservations.controller.ts
// (trecho novo — adicionar ao controller existente do Capítulo 6)

@Get(':id')
@UseGuards(BuyerGuard)
async findOne(
  @Param('id', ParseUUIDPipe) id: string,
  @CurrentUser() user: AuthenticatedUser,
) {
  const reservation = await this.prisma.reservation.findUnique({
    where: { id },
    include: { items: true },
  });

  // OWASP A01: 404 (não 403) quando o recurso pertence a outro usuário.
  // 403 vazaria a existência do UUID para um atacante tentando enumerar.
  if (!reservation || reservation.buyerId !== user.id) {
    throw new NotFoundException('Reserva não encontrada');
  }

  return reservation;
}
```

---

## Passo 7.8 — `AppModule`, `.env`, seed e Makefile

```typescript
// apps/payment-service/src/app.module.ts

import { Module } from '@nestjs/common';
import { KafkaModule } from '@showpass/kafka';

import { HealthModule } from './modules/health/health.module.js';
import { BuyersModule } from './modules/buyers/buyers.module.js';
import { OrganizersModule } from './modules/organizers/organizers.module.js';
import { OrdersModule } from './modules/orders/orders.module.js';
import { WebhooksModule } from './modules/webhooks/webhooks.module.js';

@Module({
  imports: [
    KafkaModule.forRoot({
      clientId: process.env.KAFKA_CLIENT_ID ?? 'payment-service',
      brokers: (process.env.KAFKA_BROKERS ?? 'localhost:29092').split(','),
    }),
    HealthModule,
    BuyersModule,
    OrganizersModule,
    OrdersModule,
    WebhooksModule,
  ],
})
export class AppModule {}
```

O `.env.example` lista tudo que o serviço precisa — destaque para as URLs cross-service:

```bash
# apps/payment-service/.env.example (trechos relevantes)

DATABASE_URL="postgresql://payment_svc:payment_svc_dev@localhost:5432/showpass_payment"

STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_... # do comando `stripe listen`

BOOKING_SERVICE_URL=http://localhost:3004
FRONTEND_URL=http://localhost:3001

KAFKA_BROKERS=localhost:29092
KAFKA_CONSUMER_GROUP_ID=payment-service-consumer
```

O **seed dos plans** é obrigatório — os consumers do `Organizer` fazem `findUnique({ where: { slug } })`:

```typescript
// apps/payment-service/prisma/seed.ts

import { PrismaClient } from '../src/prisma/generated/client.js';

const prisma = new PrismaClient();

async function main() {
  // Mesmos slugs que event-service e auth-service — os UUIDs diferem, os slugs são estáveis
  await prisma.plan.createMany({
    data: [
      { slug: 'free', name: 'Free', serviceFeePercent: 10.0 },
      { slug: 'pro', name: 'Pro', serviceFeePercent: 7.0 },
      { slug: 'enterprise', name: 'Enterprise', serviceFeePercent: 4.0 },
    ],
    skipDuplicates: true,
  });
}

main().finally(() => prisma.$disconnect());
```

E o `Makefile` no root ganhou o payment-service:

```makefile
db-generate:
	pnpm --filter @showpass/event-service run db:generate
	pnpm --filter @showpass/auth-service run db:generate
	pnpm --filter @showpass/booking-service run db:generate
	pnpm --filter @showpass/payment-service run db:generate

db-migrate:
	pnpm --filter @showpass/event-service run db:migrate
	pnpm --filter @showpass/auth-service run db:migrate
	pnpm --filter @showpass/booking-service run db:migrate
	pnpm --filter @showpass/payment-service run db:migrate

db-seed:
	pnpm --filter @showpass/event-service run db:seed
	pnpm --filter @showpass/auth-service run db:seed
	pnpm --filter @showpass/booking-service run db:seed
	pnpm --filter @showpass/payment-service run db:seed
```

---

## Testando na prática

Você vai precisar da [Stripe CLI](https://docs.stripe.com/stripe-cli) instalada e logada (`stripe login`).

### O que precisa estar rodando

```bash
# Terminal 1 — infraestrutura
docker compose up -d

# Terminal 2 — auth-service (porta 3006)
pnpm --filter @showpass/auth-service run dev

# Terminal 3 — event-service (porta 3003)
pnpm --filter @showpass/event-service run dev

# Terminal 4 — booking-service (porta 3004)
pnpm --filter @showpass/booking-service run dev

# Terminal 5 — payment-service (porta 3002)
pnpm --filter @showpass/payment-service run db:generate
pnpm --filter @showpass/payment-service run db:migrate
pnpm --filter @showpass/payment-service run db:seed
pnpm --filter @showpass/payment-service run dev

# Terminal 6 — Stripe CLI (reencaminha webhooks para o serviço local)
stripe listen --forward-to http://localhost:3002/webhooks/stripe

# Terminal 7 — api-gateway (porta 3000)
pnpm --filter @showpass/api-gateway run dev
```

> A primeira linha de `stripe listen` é o webhook secret: `> Ready! Your webhook signing secret is whsec_...`
> Copie para `apps/payment-service/.env` em `STRIPE_WEBHOOK_SECRET`.

### Fluxo ponta-a-ponta

**1. Login do comprador e reserva (via gateway)**

```bash
BUYER_TOKEN=$(curl -s -X POST http://localhost:3000/auth/buyers/login \
  -H "Content-Type: application/json" \
  -d '{"email":"diego@email.com","password":"MinhaSenha@123"}' | jq -r .accessToken)

# Criar reserva — pega um ticketBatchId válido do seu seed
RESERVATION=$(curl -s -X POST http://localhost:3000/bookings/reservations \
  -H "Authorization: Bearer $BUYER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"items":[{"ticketBatchId":"<uuid-do-batch>","quantity":1}]}')

RESERVATION_ID=$(echo $RESERVATION | jq -r .id)
```

**2. Criar Checkout Session**

```bash
curl -s -X POST http://localhost:3000/payments/orders \
  -H "Authorization: Bearer $BUYER_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"reservationIds\":[\"$RESERVATION_ID\"]}" | jq .
```

Resposta esperada:

```json
{
  "orderId": "018eaaaa-...",
  "checkoutUrl": "https://checkout.stripe.com/c/pay/cs_test_...",
  "status": "pending"
}
```

**3. Pagar com o cartão de teste**

Abra o `checkoutUrl`:

| Campo | Valor |
|---|---|
| Número | `4242 4242 4242 4242` |
| Validade | qualquer data futura (ex: `12/30`) |
| CVC | `123` |
| Nome / CEP | qualquer |

Após enviar, olhe o Terminal 6 (`stripe listen`): aparece `checkout.session.completed`. No Terminal 5 (payment-service), o log `Pagamento confirmado — orderId: ...`.

**4. Conferir o pedido como pago**

```bash
curl -s http://localhost:3000/payments/orders/$ORDER_ID \
  -H "Authorization: Bearer $BUYER_TOKEN" | jq .status
```

Retorna `"paid"`.

**5. Teste de idempotência — reentrega do webhook**

Copie o `evt_...` que aparece no `stripe listen` e reenvie:

```bash
stripe events resend evt_...
```

No log do payment-service, você vê `Webhook ignorado: pedido já pago`. Nenhuma emissão extra no Kafka.

**6. Teste de idempotência — segundo POST /orders com as mesmas reservas**

```bash
# Mesmo RESERVATION_ID de antes — deve retornar a MESMA checkoutUrl
curl -s -X POST http://localhost:3000/payments/orders \
  -H "Authorization: Bearer $BUYER_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"reservationIds\":[\"$RESERVATION_ID\"]}" | jq .orderId
```

Retorna o **mesmo `orderId`** — nada criado, nada cobrado.

---

## Pegadinhas comuns

| Sintoma | Causa | Correção |
|---|---|---|
| `rawBody ausente — checar main.ts` | Removeu `rawBody: true` do `NestFactory.create` | Restaurar — obrigatório para HMAC |
| `Signature verification failed` | `STRIPE_WEBHOOK_SECRET` errado ou body parsed como JSON antes da validação | Conferir `.env` e manter `rawBody: true` |
| `Organizador não encontrado na réplica local` | Consumer de `auth.organizer.*` não rodou (Kafka parado) ou plano não seedado | Subir Kafka, rodar `db:seed` em todos os serviços |
| `Reserva ... inacessível (401)` | `authHeaders` não foi repassado do gateway até o payment até o booking | Conferir `x-user-*` no `OrdersController` |
| Checkout cobra duas vezes | Idempotency key não foi passado ao Stripe | Usar sempre o **segundo arg** do `stripe.checkout.sessions.create(params, { idempotencyKey })` |
| Webhook processado duas vezes | Faltou o check `order.status === 'paid'` | Idempotência no handler é responsabilidade nossa |

---

## Recapitulando

1. **Bounded context + réplicas via Kafka** — `Buyer`, `Organizer` e `Plan` replicados; `Reservation` segue HTTP porque precisa de read-your-write
2. **Hybrid app NestJS** — HTTP (`/payments/orders`, `/webhooks/stripe`) + Kafka consumer no mesmo processo
3. **`rawBody: true`** — pré-requisito para a validação HMAC funcionar
4. **Idempotency Key** dupla: no Stripe (segundo arg do `create`) e no nosso banco (`Order.idempotencyKey` único)
5. **HMAC-SHA256** no webhook (OWASP A10) — rejeitar antes de qualquer processamento
6. **Idempotência no handler** — `order.status === 'paid'` antes de update + emit Kafka
7. **404 em vez de 403** para recursos de outro usuário (OWASP A01)
8. **Kafka `payment.confirmed`** — worker-service gera ingressos assincronamente sem bloquear a resposta ao Stripe

---

## Próximo capítulo

[Capítulo 8 → Search Service](cap-08-search-service.md)
