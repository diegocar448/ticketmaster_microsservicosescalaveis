# Capítulo 7 — Payment Service

> **Objetivo:** Integrar o Stripe com Checkout Session, Idempotency Keys para evitar cobranças duplicadas, e validação HMAC nos webhooks — o único ponto de confirmação de pagamentos.

## O que você vai aprender

- Stripe Checkout Session vs Payment Intents — quando usar cada um
- Idempotency Keys: mesmo retry = mesma cobrança, sem duplicar
- Webhook HMAC (OWASP A10): apenas o Stripe pode confirmar pagamentos
- Idempotência no processamento: re-envio do Stripe não processa duas vezes
- Rollback de reservas quando pagamento falha ou expira

---

## Passo 7.1 — `VerifyStripeWebhook` Middleware (OWASP A10)

```typescript
// apps/payment-service/src/common/middleware/verify-stripe-webhook.middleware.ts
//
// OWASP A10: Valida a assinatura HMAC do Stripe antes de qualquer processamento.
// Sem esta validação, qualquer pessoa poderia POST para /webhooks/stripe
// e confirmar pagamentos falsos.
//
// Como funciona:
// Stripe assina o payload com HMAC-SHA256 usando um webhook secret.
// Verificamos a assinatura ANTES de parsear o JSON.
// Se inválida → rejeitar imediatamente, sem logar o payload (pode ter dados sensíveis).

import {
  Injectable,
  NestMiddleware,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import Stripe from 'stripe';

@Injectable()
export class VerifyStripeWebhookMiddleware implements NestMiddleware {
  private readonly logger = new Logger(VerifyStripeWebhookMiddleware.name);

  private readonly stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: '2024-12-18.acacia',
  });

  private readonly webhookSecret = process.env.STRIPE_WEBHOOK_SECRET!;

  use(req: Request, _res: Response, next: NextFunction): void {
    const signature = req.headers['stripe-signature'];

    if (!signature) {
      this.logger.warn('Webhook sem assinatura Stripe', { ip: req.ip });
      throw new BadRequestException('Assinatura ausente');
    }

    try {
      // O Stripe SDK verifica:
      // 1. A assinatura HMAC-SHA256 do payload
      // 2. O timestamp (previne replay attacks — rejeita eventos > 5 minutos)
      //
      // IMPORTANTE: req.body deve ser o raw buffer (não parsear JSON antes)
      // O Express precisa de express.raw() para esta rota
      const event = this.stripe.webhooks.constructEvent(
        req.body as Buffer,
        signature,
        this.webhookSecret,
      );

      // Injetar o evento validado na request para o controller usar
      (req as Request & { stripeEvent: Stripe.Event }).stripeEvent = event;

      next();
    } catch (err) {
      this.logger.warn('Assinatura Stripe inválida', {
        error: (err as Error).message,
        ip: req.ip,
      });

      // Não expor detalhes do erro (pode revelar informações sobre a chave)
      throw new BadRequestException('Assinatura inválida');
    }
  }
}
```

---

## Passo 7.2 — Order Service

```typescript
// apps/payment-service/src/modules/orders/orders.service.ts

import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { KafkaProducerService } from '@showpass/kafka';
import { KAFKA_TOPICS } from '@showpass/types';
import Stripe from 'stripe';
import { createHash } from 'crypto';

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  private readonly stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: '2024-12-18.acacia',
  });

  constructor(
    private readonly prisma: PrismaService,
    private readonly kafka: KafkaProducerService,
  ) {}

  /**
   * Cria um pedido e a Checkout Session do Stripe.
   *
   * Idempotency Key: hash SHA-256 dos reservation IDs + buyer ID.
   * Se o buyer fizer retry (falha de rede, duplo clique), o Stripe
   * reconhece o mesmo key e retorna a mesma session — sem cobrar de novo.
   */
  async createCheckout(buyerId: string, reservationIds: string[]) {
    // ─── 1. Buscar reservas do booking-service ─────────────────────────────────
    const reservations = await this.fetchReservations(reservationIds, buyerId);

    if (reservations.length === 0) {
      throw new BadRequestException('Nenhuma reserva válida encontrada');
    }

    // ─── 2. Calcular totais ────────────────────────────────────────────────────
    const subtotal = reservations.reduce(
      (sum, r) => sum + r.items.reduce((s, i) => s + Number(i.unitPrice) * i.quantity, 0),
      0,
    );

    // Taxa de serviço: buscar % do plano do organizer
    const organizerId = reservations[0].organizerId;
    const feePct = await this.getServiceFeePercent(organizerId);
    const serviceFee = Math.round(subtotal * (feePct / 100) * 100) / 100;
    const total = subtotal + serviceFee;

    // ─── 3. Idempotency Key ────────────────────────────────────────────────────
    //
    // Hash determinístico: mesmas reservas + mesmo buyer = mesmo key.
    // Protege contra:
    // - Retry do cliente (falha de rede)
    // - Double-click no botão de compra
    // - Re-envio acidental
    const idempotencyKey = createHash('sha256')
      .update(`${buyerId}:${[...reservationIds].sort().join(',')}`)
      .digest('hex');

    // Verificar se já existe um pedido para este conjunto (idempotência no DB)
    const existingOrder = await this.prisma.order.findUnique({
      where: { idempotencyKey },
    });

    if (existingOrder?.stripeCheckoutSessionId) {
      // Retornar a session existente — não criar nova cobrança
      const session = await this.stripe.checkout.sessions.retrieve(
        existingOrder.stripeCheckoutSessionId,
      );
      return { orderId: existingOrder.id, checkoutUrl: session.url };
    }

    // ─── 4. Criar Order no banco ───────────────────────────────────────────────
    const eventId = reservations[0].eventId;

    const order = await this.prisma.order.create({
      data: {
        buyerId,
        eventId,
        organizerId,
        status: 'pending',
        subtotal,
        serviceFee,
        total,
        idempotencyKey,
        items: {
          create: reservations.flatMap((r) =>
            r.items.map((item) => ({
              reservationId: r.id,
              ticketBatchId: item.ticketBatchId,
              seatId: item.seatId,
              unitPrice: item.unitPrice,
              quantity: item.quantity,
              total: Number(item.unitPrice) * item.quantity,
            })),
          ),
        },
      },
    });

    // ─── 5. Criar Stripe Checkout Session ─────────────────────────────────────
    const lineItems = this.buildLineItems(reservations, serviceFee);
    const eventData = await this.fetchEventData(eventId);

    const session = await this.stripe.checkout.sessions.create(
      {
        payment_method_types: ['card'],
        line_items: lineItems,
        mode: 'payment',
        success_url: `${process.env.FRONTEND_URL}/checkout/success?order=${order.id}`,
        cancel_url: `${process.env.FRONTEND_URL}/events/${eventData.slug}?checkout=cancelled`,
        customer_email: await this.getBuyerEmail(buyerId),
        metadata: {
          order_id: order.id,
          buyer_id: buyerId,
          event_id: eventId,
        },
        // Checkout expira 1 minuto antes do lock Redis (14 minutos)
        expires_at: Math.floor(Date.now() / 1000) + 14 * 60,
        payment_intent_data: {
          metadata: {
            order_id: order.id,
            buyer_id: buyerId,
          },
        },
      },
      {
        // Idempotency key no header Stripe — previne Checkout Session duplicada
        idempotencyKey,
      },
    );

    // Salvar IDs do Stripe no pedido
    await this.prisma.order.update({
      where: { id: order.id },
      data: {
        stripeCheckoutSessionId: session.id,
        stripePaymentIntentId: session.payment_intent as string,
      },
    });

    this.logger.log('Checkout criado', { orderId: order.id, sessionId: session.id });

    return { orderId: order.id, checkoutUrl: session.url! };
  }

  // ─── Construir line_items do Stripe ──────────────────────────────────────────

  private buildLineItems(
    reservations: Array<{
      items: Array<{
        ticketBatchName: string;
        unitPrice: number;
        quantity: number;
        seatLabel?: string;
        eventTitle: string;
        thumbnailUrl?: string;
      }>;
    }>,
    serviceFee: number,
  ): Stripe.Checkout.SessionCreateParams.LineItem[] {
    const items: Stripe.Checkout.SessionCreateParams.LineItem[] = [];

    for (const reservation of reservations) {
      for (const item of reservation.items) {
        items.push({
          price_data: {
            currency: 'brl',
            unit_amount: Math.round(item.unitPrice * 100),  // centavos
            product_data: {
              name: item.eventTitle,
              description: item.seatLabel
                ? `${item.ticketBatchName} • ${item.seatLabel}`
                : item.ticketBatchName,
              images: item.thumbnailUrl ? [item.thumbnailUrl] : [],
            },
          },
          quantity: item.quantity,
        });
      }
    }

    // Taxa de serviço como item separado (transparência para o comprador)
    if (serviceFee > 0) {
      items.push({
        price_data: {
          currency: 'brl',
          unit_amount: Math.round(serviceFee * 100),
          product_data: { name: 'Taxa de serviço ShowPass' },
        },
        quantity: 1,
      });
    }

    return items;
  }

  private async fetchReservations(ids: string[], buyerId: string): Promise<any[]> {
    // HTTP call para o booking-service
    const url = `${process.env.BOOKING_SERVICE_URL}/bookings/reservations/batch`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, buyerId }),
    });
    return res.json() as Promise<any[]>;
  }

  private async fetchEventData(eventId: string): Promise<{ slug: string }> {
    const url = `${process.env.EVENT_SERVICE_URL}/events/${eventId}`;
    const res = await fetch(url);
    return res.json() as Promise<{ slug: string }>;
  }

  private async getServiceFeePercent(organizerId: string): Promise<number> {
    const url = `${process.env.EVENT_SERVICE_URL}/organizers/${organizerId}/plan`;
    const res = await fetch(url);
    const data = await res.json() as { serviceFeePercent: number };
    return data.serviceFeePercent;
  }

  private async getBuyerEmail(buyerId: string): Promise<string> {
    const url = `${process.env.BOOKING_SERVICE_URL}/bookings/buyers/${buyerId}/email`;
    const res = await fetch(url);
    const data = await res.json() as { email: string };
    return data.email;
  }
}
```

---

## Passo 7.3 — Webhook Controller

```typescript
// apps/payment-service/src/modules/webhooks/webhook.controller.ts
//
// Processa eventos do Stripe de forma IDEMPOTENTE.
// O Stripe pode enviar o mesmo evento múltiplas vezes (retries).
// Idempotência garante que processar duas vezes = processar uma.

import { Controller, Post, Req, Res, HttpCode } from '@nestjs/common';
import { Request, Response } from 'express';
import { Logger } from '@nestjs/common';
import Stripe from 'stripe';
import { PrismaService } from '../../prisma/prisma.service';
import { KafkaProducerService } from '@showpass/kafka';
import { KAFKA_TOPICS } from '@showpass/types';

@Controller('webhooks')
export class WebhookController {
  private readonly logger = new Logger(WebhookController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly kafka: KafkaProducerService,
  ) {}

  /**
   * Endpoint do Stripe webhook.
   * A validação HMAC já foi feita pelo VerifyStripeWebhookMiddleware.
   * Aqui apenas roteamos o evento.
   */
  @Post('stripe')
  @HttpCode(200)  // Stripe espera 200 — qualquer outro code ele retenta
  async handleStripe(
    @Req() req: Request & { stripeEvent: Stripe.Event },
    @Res({ passthrough: true }) _res: Response,
  ): Promise<{ received: boolean }> {
    const event = req.stripeEvent;

    this.logger.log(`Webhook recebido: ${event.type}`, { eventId: event.id });

    // Dispatch baseado no tipo do evento
    switch (event.type) {
      case 'payment_intent.succeeded':
        await this.handlePaymentSucceeded(event.data.object as Stripe.PaymentIntent);
        break;

      case 'payment_intent.payment_failed':
        await this.handlePaymentFailed(event.data.object as Stripe.PaymentIntent);
        break;

      case 'checkout.session.expired':
        await this.handleCheckoutExpired(event.data.object as Stripe.Checkout.Session);
        break;

      case 'charge.refunded':
        await this.handleRefunded(event.data.object as Stripe.Charge);
        break;

      default:
        this.logger.debug(`Evento ignorado: ${event.type}`);
    }

    return { received: true };
  }

  private async handlePaymentSucceeded(paymentIntent: Stripe.PaymentIntent): Promise<void> {
    const orderId = paymentIntent.metadata.order_id;
    if (!orderId) return;

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });

    if (!order) {
      this.logger.error('Pedido não encontrado no webhook', { orderId });
      return;
    }

    // IDEMPOTÊNCIA: se já foi processado, ignorar silenciosamente
    // O Stripe pode enviar o mesmo evento múltiplas vezes
    if (order.status === 'paid') {
      this.logger.info('Webhook ignorado: pedido já processado (idempotente)', { orderId });
      return;
    }

    // Atualizar status do pedido
    const charge = paymentIntent.latest_charge as Stripe.Charge | null;

    await this.prisma.order.update({
      where: { id: orderId },
      data: {
        status: 'paid',
        stripeChargeId: charge?.id,
        paymentMethod: charge?.payment_method_details?.type,
        cardLastFour: charge?.payment_method_details?.card?.last4,
        cardBrand: charge?.payment_method_details?.card?.brand,
        paidAt: new Date(),
      },
    });

    // Emitir evento para o worker-service gerar os ingressos e enviar e-mail
    await this.kafka.emit(
      KAFKA_TOPICS.PAYMENT_CONFIRMED,
      {
        orderId: order.id,
        buyerId: order.buyerId,
        organizerId: order.organizerId,
        items: order.items.map((i) => ({
          reservationId: i.reservationId,
          ticketBatchId: i.ticketBatchId,
          seatId: i.seatId,
          unitPrice: Number(i.unitPrice),
        })),
        paidAt: new Date(),
      },
      orderId,
    );

    this.logger.log('Pagamento confirmado', { orderId, amount: paymentIntent.amount });
  }

  private async handlePaymentFailed(paymentIntent: Stripe.PaymentIntent): Promise<void> {
    const orderId = paymentIntent.metadata.order_id;
    if (!orderId) return;

    const order = await this.prisma.order.findFirst({
      where: { id: orderId, status: 'pending' },
    });

    if (!order) return;  // já processado

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
    const orderId = charge.metadata.order_id;
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

## Passo 7.4 — Configurar raw body para validação HMAC

```typescript
// apps/payment-service/src/main.ts
//
// O Stripe webhook EXIGE o body raw (Buffer), não o JSON parsado.
// Configurar express para preservar o raw body apenas na rota do webhook.

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import express from 'express';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    // Desabilitar body parser global — vamos configurar por rota
    bodyParser: false,
  });

  // ─── Raw body para o webhook do Stripe ────────────────────────────────────
  // DEVE vir antes do JSON parser global
  app.use(
    '/webhooks/stripe',
    express.raw({ type: 'application/json' }),
  );

  // ─── JSON parser para todas as outras rotas ────────────────────────────────
  app.use(express.json({ limit: '10mb' }));

  await app.listen(process.env.PORT ?? 3004);
}

void bootstrap();
```

---

## Testando na prática

O pagamento usa o Stripe em modo teste. Você precisa da [Stripe CLI](https://stripe.com/docs/stripe-cli) instalada para simular webhooks localmente.

### O que precisa estar rodando

```bash
# Terminal 1 — infraestrutura
docker compose up -d

# Terminal 2 — auth-service
pnpm --filter @showpass/auth-service run dev          # porta 3006

# Terminal 3 — event-service
pnpm --filter @showpass/event-service run dev         # porta 3003

# Terminal 4 — booking-service
pnpm --filter @showpass/booking-service run dev       # porta 3004

# Terminal 5 — payment-service
pnpm --filter @showpass/payment-service run db:generate
pnpm --filter @showpass/payment-service run db:migrate
pnpm --filter @showpass/payment-service run dev       # porta 3002

# Terminal 6 — Stripe CLI (reencaminha webhooks para o serviço local)
stripe listen --forward-to http://localhost:3002/webhooks/stripe
```

> O Stripe CLI exibe o webhook secret na primeira linha: `> Ready! Your webhook signing secret is whsec_...`
> Copie esse valor e configure em `.env` do payment-service: `STRIPE_WEBHOOK_SECRET=whsec_...`

### Preparação

```bash
# Token de comprador
BUYER_TOKEN=$(curl -s -X POST http://localhost:3006/auth/buyers/login \
  -H "Content-Type: application/json" \
  -d '{"email":"joao@email.com","password":"MinhaSenha@123"}' | jq -r .accessToken)

# ID da reserva pendente (crie uma via booking-service se necessário)
RESERVATION_ID="018eaaaa-..."
```

### Passo a passo

**1. Criar uma Checkout Session no Stripe**

```bash
curl -s -X POST http://localhost:3002/orders \
  -H "Authorization: Bearer $BUYER_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"reservationId\": \"$RESERVATION_ID\",
    \"successUrl\": \"http://localhost:3001/checkout/success\",
    \"cancelUrl\": \"http://localhost:3001/checkout/cancel\"
  }" | jq .
```

Resposta esperada:

```json
{
  "orderId": "018ecccc-...",
  "checkoutUrl": "https://checkout.stripe.com/c/pay/cs_test_...",
  "status": "pending"
}
```

**2. Completar o pagamento no Stripe (modo teste)**

Abra o `checkoutUrl` no browser. Use o cartão de teste do Stripe:

| Campo | Valor |
|---|---|
| Número | `4242 4242 4242 4242` |
| Validade | qualquer data futura (ex: `12/26`) |
| CVC | qualquer 3 dígitos (ex: `123`) |
| CEP | qualquer (ex: `00000-000`) |

Após completar, o Stripe envia o webhook `checkout.session.completed` para o Terminal 6.

**3. Verificar o processamento do webhook**

No terminal do payment-service, você verá:

```
[WebhookController] checkout.session.completed recebido — orderId: 018ecccc-...
[OrderService] Pagamento confirmado — emitindo payment.confirmed para Kafka
```

**4. Verificar status do pedido**

```bash
curl -s http://localhost:3002/orders/$ORDER_ID \
  -H "Authorization: Bearer $BUYER_TOKEN" | jq .status
```

Resposta esperada: `"paid"`

**5. Simular webhook manualmente via Stripe CLI**

Em vez de abrir o browser, você pode disparar o evento de confirmação diretamente:

```bash
stripe trigger checkout.session.completed
```

O payment-service receberá o evento e processará. Útil para testar o worker-service no próximo capítulo sem precisar preencher formulário de cartão.

**6. Testar idempotência — entregar o webhook duas vezes**

Copie o ID do evento Stripe do log (`evt_...`) e reenvie:

```bash
stripe events resend evt_...
```

O payment-service deve processar sem duplicar — o cheque de `order.status === 'paid'` impede o reprocessamento.

---

## Recapitulando

1. **Idempotency Key** (SHA-256 dos IDs) — mesma reserva = mesma cobrança, sem duplicar mesmo em retries
2. **Stripe Checkout Session** — UI de pagamento pronta, sem PCI compliance manual
3. **HMAC-SHA256 no webhook** — apenas o Stripe pode confirmar pagamentos (OWASP A10)
4. **Replay attack prevention** — Stripe SDK rejeita eventos com mais de 5 minutos
5. **Idempotência no processamento** — checar `order.status === 'paid'` antes de processar novamente
6. **Kafka emit no webhook** — worker-service gera ingressos assincronamente sem bloquear a resposta ao Stripe

---

## Próximo capítulo

[Capítulo 8 → Search Service](cap-08-search-service.md)
