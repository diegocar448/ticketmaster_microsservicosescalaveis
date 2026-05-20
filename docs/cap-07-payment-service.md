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

> **Lint estrito — regras que o código deste capítulo deve seguir** (o CI roda
> `eslint src/` com type-checking; snippets em notação simplificada abaixo
> precisam destes ajustes para passar):
> - **`process.env['X']`** (colchete, não `.X`) — `noPropertyAccessFromIndexSignature`.
> - **Sem `!`**: use o helper `requireEnv('X')` (fail-fast) no lugar de `process.env.X!`.
> - **Templates**: `${String(n)}` para number, e `FRONTEND_URL` resolvido a um
>   `const` (`process.env['FRONTEND_URL'] ?? ''`) antes de interpolar
>   (`restrict-template-expressions` rejeita `string | undefined`/`number`).
> - **`metadata`**: `session.metadata?.['order_id']` (session pode ser null →
>   mantém `?.`); já `paymentIntent.metadata['order_id']` e
>   `charge.metadata['order_id']` são **sem `?.`** (Stripe tipa como sempre
>   presente — `no-unnecessary-condition`). Sempre acesso por colchete.
> - **Retorno explícito** em todo método público (controllers:
>   `ReturnType<Service['m']>`; services: `Promise<...>`).
> - **`catch`**: `(err: unknown) => { ... }` com chaves.

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

// Contrato com o booking-service (GET /bookings/reservations/:id).
//
// booking enriquece cada item com dados das suas RÉPLICAS LOCAIS:
//   - `ticketBatchName`  ← réplica TicketBatch (cap-06, Passo 6.11 de TicketBatch)
//   - `eventTitle` + `thumbnailUrl` ← réplica Event (cap-06, Passo 6.11)
//
// Sem essas réplicas, o booking devolveria a entidade Prisma crua e o Stripe
// rejeitaria a criação da Checkout Session com:
//   400 "You must specify either product or product_data when creating a price."
// porque `product_data.name` chegaria como string vazia.
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

// Lint estrito do projeto: `no-non-null-assertion` proíbe `process.env.X!`;
// `noPropertyAccessFromIndexSignature` exige acesso por colchete
// (process.env['X']). Helper de fail-fast substitui o `!` com erro claro.
function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  return v;
}

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  private readonly stripe = new Stripe(requireEnv('STRIPE_SECRET_KEY'), {
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
      // use-unknown-in-catch + no-confusing-void-expression: err: unknown e
      // corpo com chaves (não retornar a expressão void do logger).
      .catch((err: unknown) => {
        this.logger.warn('Falha ao emitir order.created (best-effort)', {
          error: (err as Error).message,
        });
      });

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
  // explicit-function-return-type: OrderWithItems =
  // Prisma.OrderGetPayload<{ include: { items: true } }> (importe `Prisma`
  // de '../../prisma/generated/index.js').
  async getOrder(
    orderId: string,
    buyerId: string,
  ): Promise<OrderWithItems> {
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
import { CurrentUser, type AuthenticatedUser } from '@showpass/types/nest';
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
  ): ReturnType<OrdersService['createCheckout']> {
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
  ): ReturnType<OrdersService['getOrder']> {
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

// Mesmo helper do OrdersService (no-non-null-assertion proíbe `!`).
function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  return v;
}

@Controller('webhooks')
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  private readonly stripe = new Stripe(requireEnv('STRIPE_SECRET_KEY'));
  private readonly webhookSecret = requireEnv('STRIPE_WEBHOOK_SECRET');

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
// Retorno é fronteira HTTP (JSON serializado); o corpo permanece tipado.
// `Promise<unknown>` satisfaz explicit-function-return-type sem duplicar o
// shape enriquecido inline.
async findOne(
  @Param('id', ParseUUIDPipe) id: string,
  @CurrentUser() user: AuthenticatedUser,
): Promise<unknown> {
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

O **seed dos plans** é obrigatório — os consumers do `Organizer` fazem `findUnique({ where: { slug } })`. Mesmos slugs do auth-service e event-service (UUIDs diferem entre bancos, slugs são estáveis):

```typescript
// apps/payment-service/prisma/seed.ts

import 'dotenv/config';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/prisma/generated/index.js';

// Prisma 7: "client" engine exige driver adapter (não usa binary engine).
// dotenv/config carrega DATABASE_URL antes do Pool se conectar.
const pool = new Pool({ connectionString: process.env['DATABASE_URL'] });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main(): Promise<void> {
  const plans = [
    { slug: 'free',       name: 'Free',       serviceFeePercent: 10.0 },
    { slug: 'pro',        name: 'Pro',        serviceFeePercent:  7.0 },
    { slug: 'enterprise', name: 'Enterprise', serviceFeePercent:  4.0 },
  ];

  for (const plan of plans) {
    await prisma.plan.upsert({
      where:  { slug: plan.slug },
      create: plan,
      update: { name: plan.name, serviceFeePercent: plan.serviceFeePercent },
    });
  }

  console.log('Seed payment-service concluído: 3 planos (free/pro/enterprise)');
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
```

> **Por que o `new PrismaClient()` sem argumento falha com `PrismaClientInitializationError: 'PrismaClientOptions'`:** Prisma 7 removeu o binary engine nativo em favor do engine `"client"` em TypeScript, que conversa com o banco via **driver adapter**. Sem `{ adapter }`, o cliente não sabe como abrir conexão. Padrão idêntico em todos os seeds dos serviços (auth/event/payment).

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

## Setup do Stripe (API keys + CLI)

Antes de testar, você precisa de **duas coisas do Stripe**: uma **Secret Key** (para o payment-service chamar a API do Stripe) e um **Webhook Secret** (para validar HMAC dos webhooks recebidos). Ambas são obtidas em conta no **test mode** — zero custo, sem cartão.

### 1. Criar conta Stripe (se ainda não tem)

1. Acesse [stripe.com](https://stripe.com) e clique em **Start now** / **Sign up**
2. Informe email + senha — **não precisa** preencher dados da empresa agora (só para sair do test mode)
3. Confirme o email

### 2. Pegar a `STRIPE_SECRET_KEY`

1. Logue em [dashboard.stripe.com](https://dashboard.stripe.com)
2. No canto superior direito, **confirme que o toggle "Test mode" está LIGADO** (fica laranja/amarelo). Essa é a diferença entre cobrar cartões de verdade (`sk_live_...`) e usar cartões de teste (`sk_test_...`)
3. Menu lateral → **Desenvolvedores** (Developers) → **Chaves da API** (API keys)
4. Na seção **Chaves padrão** (Standard keys), você verá três linhas:

   | Nome na tela     | Prefixo        | Usar onde?                                              |
   |------------------|----------------|---------------------------------------------------------|
   | Chave publicável | `pk_test_...`  | Só frontend/mobile (cap-12). **Não** no backend         |
   | **Chave secreta**| `sk_test_...`  | **`STRIPE_SECRET_KEY` no `.env` do payment-service**    |
   | Chave restrita   | `rk_test_...`  | Não usamos (permissões granulares — uso avançado)       |

5. Clique em **"Revelar chave secreta de teste"** → copie o valor (começa com `sk_test_51...` e tem ~107 caracteres)

6. Cole em [apps/payment-service/.env](apps/payment-service/.env):

   ```bash
   STRIPE_SECRET_KEY=sk_test_51AbCdEfGhIj...                 # ← sua chave real aqui
   STRIPE_WEBHOOK_SECRET=whsec_GERADO_PELO_STRIPE_CLI        # preenchido no passo 4
   ```

   > **Nunca commite essa chave.** O `.env` está no `.gitignore`. Se vazar por acidente, vá em **Desenvolvedores → Chaves da API → Girar chave** imediatamente.

### 3. Instalar a Stripe CLI

A Stripe CLI faz o túnel entre o Stripe (que está na internet) e seu localhost:3002 — sem ela, você teria que expor o serviço via ngrok ou deploy para testar webhooks. Ela **não vem** nos repositórios padrão do Ubuntu.

**Opção A — APT (recomendado, atualiza com `sudo apt upgrade`):**

```bash
# Chave GPG do Stripe
curl -fsSL https://packages.stripe.dev/api/security/keypair/stripe-cli-gpg/public \
  | sudo gpg --dearmor -o /usr/share/keyrings/stripe.gpg

# Repositório APT
echo "deb [signed-by=/usr/share/keyrings/stripe.gpg] https://packages.stripe.dev/stripe-cli-debian-local stable main" \
  | sudo tee -a /etc/apt/sources.list.d/stripe.list

sudo apt update
sudo apt install -y stripe
```

**Opção B — Binário direto (sem sudo):**

```bash
VERSION=$(curl -s https://api.github.com/repos/stripe/stripe-cli/releases/latest | grep -Po '"tag_name": "v\K[^"]+')
mkdir -p ~/.local/bin
curl -L "https://github.com/stripe/stripe-cli/releases/download/v${VERSION}/stripe_${VERSION}_linux_x86_64.tar.gz" \
  | tar -xz -C ~/.local/bin stripe
```

**Validar:**

```bash
stripe --version       # deve imprimir "stripe version 1.30.x" ou similar
```

### 4. Autenticar a CLI (`stripe login`)

```bash
stripe login
```

A CLI imprime algo como:

```
Your pairing code is: grace-defeat-fun-wise
This pairing code verifies your authentication with Stripe.
To authenticate with Stripe, please go to: https://dashboard.stripe.com/stripecli/confirm_auth?t=XXXXXXXXXXXXXXXXXXXXXXXXXXX...
Waiting for confirmation...
```

Fluxo de confirmação:

1. **Copie a URL INTEIRA** que apareceu no seu terminal (começa com `https://dashboard.stripe.com/stripecli/confirm_auth?t=` e continua por ~180 caracteres)
   > **Gotcha comum:** não é um valor que você encontra em outro lugar. A CLI gera esse URL na hora com um token único em `?t=...` — copie exatamente o que o terminal mostrou, não o exemplo da documentação
2. Cole no **browser do Windows** (não tem browser no WSL puro)
3. Na página que abrir, **confira o pairing code** — tem que bater exatamente com o do terminal (ex: `grace-defeat-fun-wise`)
4. Clique em **"Allow access"**
5. Volte ao terminal: deve aparecer `> Done! The Stripe CLI is configured for your account with account id acct_1TOU8xD...`

**Se der erro "O token de confirmação não pode ser carregado":**
- Token expirou (~2 min) ou URL veio truncada no copy/paste
- Pressione `Ctrl+C` no terminal, rode `stripe login` de novo, copie a URL completa

**WSL tip (opcional):** para o `stripe login` abrir o browser do Windows automaticamente nas próximas vezes:

```bash
sudo apt install wslu
echo 'export BROWSER=wslview' >> ~/.bashrc
source ~/.bashrc
```

A autenticação fica salva em `~/.config/stripe/config.toml` — você só roda `stripe login` **uma vez por máquina**.

### 5. Gerar e salvar o `STRIPE_WEBHOOK_SECRET`

O webhook secret é **diferente** da Secret Key — ele é gerado dinamicamente pelo `stripe listen` e usado para validar HMAC-SHA256 dos eventos que o Stripe envia (OWASP A10). Em produção, ele é criado manualmente no dashboard quando você cadastra o endpoint público; em dev, a CLI faz isso automaticamente.

Em um **terminal separado** (deixe este rodando enquanto testa):

```bash
stripe listen --forward-to http://localhost:3002/webhooks/stripe
```

Primeira linha do output:

```
> Ready! Your webhook signing secret is whsec_abc123def456... (^C to quit)
```

Copie esse `whsec_...` para [apps/payment-service/.env](apps/payment-service/.env):

```bash
STRIPE_WEBHOOK_SECRET=whsec_abc123def456...
```

**Reinicie o payment-service** (ele só lê o `.env` no boot):

```bash
./scripts/dev.sh stop
./scripts/dev.sh start
```

> **Gotcha importante:** o `whsec_...` **muda toda vez** que você reinicia `stripe listen`. Se fechar o terminal e abrir de novo, precisa atualizar o `.env` + reiniciar o payment-service. Em produção isso não é problema — o secret é estático porque o endpoint está registrado permanentemente no dashboard.

---

## Testando na prática

Com o Stripe configurado (passos acima) e os 5 serviços rodando, agora você consegue testar o fluxo ponta-a-ponta.

### O que precisa estar rodando

```bash
# Terminal 1 — infraestrutura
docker compose up -d

# Migrations + seed do payment-service (uma vez por ambiente novo)
pnpm --filter @showpass/payment-service run db:generate
pnpm --filter @showpass/payment-service run db:migrate
pnpm --filter @showpass/payment-service run db:seed

# Terminal 2 — todos os 5 serviços NestJS em background
make dev-services        # auth(3006) + event(3003) + booking(3004) + payment(3002) + gateway(3000)
make dev-status          # confirme 5 bolinhas verdes

# Terminal 3 — Stripe CLI (mantenha rodando; já configurado no "Setup do Stripe" acima)
stripe listen --forward-to http://localhost:3002/webhooks/stripe
```

> Se ainda não configurou `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` no `.env`, volte para a seção **[Setup do Stripe (API keys + CLI)](#setup-do-stripe-api-keys--cli)** — sem isso, `POST /payments/orders` retorna **401 do Stripe** (não do seu gateway) com mensagem `Invalid API Key provided: sk_test_...`.

> **`payment-service` no `dev-services`:** este capítulo é o primeiro que adiciona o `payment-service` ao conjunto de serviços iniciados por `make dev-services`. Se você estiver revisitando o repo num ambiente antigo e o `make dev-status` mostrar `payment-service — parado`, sua cópia de `scripts/dev.sh` está desatualizada — atualize a partir do cap-07 ou siga o guia [**Como adicionar um novo microsserviço ao `dev-services`**](cap-01-ambiente-monorepo.md#como-adicionar-um-novo-microsserviço-ao-dev-services) do cap-01.

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
