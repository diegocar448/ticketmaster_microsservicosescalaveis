// apps/payment-service/src/modules/orders/orders.service.ts
//
// Cria pedidos e Stripe Checkout Sessions com idempotency.
//
// Fluxo do checkout:
// 1. Busca reservas no booking-service (HTTP — booking é a fonte da verdade).
// 2. Resolve organizer + plan local (replicados via Kafka) para feePercent.
// 3. Resolve email do buyer local (replicado via Kafka) para o Stripe.
// 4. Calcula idempotencyKey = sha256(buyerId + reservationIds ordenados).
//    Retry com mesmo conjunto retorna a MESMA Checkout Session — sem duplicar.
// 5. Cria Order pendente + chama Stripe com o idempotencyKey no header.
//
// Referências:
// - OWASP A08 (Software/Data Integrity): idempotency previne dupla cobrança
//   em retries de rede / double-click do cliente.
// - ADR: por que Stripe Checkout em vez de Payment Intents diretos? PCI
//   scope reduzido — dados de cartão NUNCA tocam nossos servidores.

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { KafkaProducerService } from '@showpass/kafka';
import { KAFKA_TOPICS } from '@showpass/types';
import { createHash } from 'node:crypto';
import Stripe from 'stripe';

// Stripe 22 reorganizou o namespace `Checkout`: os sub-namespaces (como
// SessionCreateParams.LineItem) deixaram de ser acessíveis via alias de tipo
// em Stripe.Checkout. Usamos o shape inline para não depender dessa estrutura.
type StripeLineItem = NonNullable<
  Parameters<Stripe['checkout']['sessions']['create']>[0]
>['line_items'] extends Array<infer L> | undefined
  ? L
  : never;

import { PrismaService } from '../../prisma/prisma.service.js';

// Shape que esperamos receber do booking-service em GET /bookings/reservations/:id
interface ReservationSnapshot {
  id: string;
  buyerId: string;
  eventId: string;
  organizerId: string;
  status: string;
  expiresAt: string;
  items: Array<{
    id: string;
    reservationId: string;
    ticketBatchId: string;
    seatId: string | null;
    unitPrice: string; // Decimal serializado como string pelo Prisma
    quantity: number;
  }>;
}

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);
  private readonly stripe: Stripe;
  private readonly bookingServiceUrl: string;
  private readonly frontendUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly kafka: KafkaProducerService,
  ) {
    const apiKey = process.env['STRIPE_SECRET_KEY'];
    if (!apiKey) {
      throw new Error('STRIPE_SECRET_KEY não configurada');
    }

    // apiVersion: fixar ou omitir — fixar evita quebra quando Stripe sobe
    // a default da conta. null = usar default da conta (ok em dev).
    this.stripe = new Stripe(apiKey);

    this.bookingServiceUrl =
      process.env['BOOKING_SERVICE_URL'] ?? 'http://localhost:3004';
    this.frontendUrl = process.env['FRONTEND_URL'] ?? 'http://localhost:3001';
  }

  async createCheckout(
    buyerId: string,
    reservationIds: string[],
    authHeaders: Record<string, string>,
  ): Promise<{ orderId: string; checkoutUrl: string }> {
    // ─── 1. Buscar reservas ──────────────────────────────────────────────────
    const reservations = await this.fetchReservations(reservationIds, authHeaders);

    // Todas as reservas devem ser do mesmo buyer E do mesmo organizer.
    // Mesmo organizer: checkout único só faz sentido por evento.
    for (const r of reservations) {
      if (r.buyerId !== buyerId) {
        throw new ForbiddenException('Reserva pertence a outro comprador');
      }
      if (r.status !== 'pending') {
        throw new BadRequestException(`Reserva ${r.id} não está mais pendente`);
      }
    }

    const organizerId = reservations[0]!.organizerId;
    const eventId = reservations[0]!.eventId;

    if (reservations.some((r) => r.organizerId !== organizerId)) {
      throw new BadRequestException('Reservas de organizers diferentes em um único checkout');
    }

    // ─── 2. Totais ────────────────────────────────────────────────────────────
    const subtotal = reservations.reduce(
      (sum, r) =>
        sum +
        r.items.reduce((s, i) => s + Number(i.unitPrice) * i.quantity, 0),
      0,
    );

    const feePct = await this.getServiceFeePercent(organizerId);
    const serviceFee = Math.round(subtotal * (feePct / 100) * 100) / 100;
    const total = subtotal + serviceFee;

    // ─── 3. Idempotency key ──────────────────────────────────────────────────
    // Hash determinístico: mesmas reservas + mesmo buyer = mesmo key.
    // Se a Order já existe com este key, retornamos a sessão existente.
    const idempotencyKey = createHash('sha256')
      .update(`${buyerId}:${[...reservationIds].sort().join(',')}`)
      .digest('hex');

    const existing = await this.prisma.order.findUnique({
      where: { idempotencyKey },
    });

    if (existing?.stripeCheckoutSessionId) {
      const session = await this.stripe.checkout.sessions.retrieve(
        existing.stripeCheckoutSessionId,
      );
      return { orderId: existing.id, checkoutUrl: session.url ?? '' };
    }

    // ─── 4. Criar Order (status=pending) — ou reutilizar Order órfã ──────────
    // Caso de retomada: um POST anterior criou o Order mas falhou ao chamar
    // o Stripe (rede/chave/etc). O UNIQUE de idempotencyKey impede recriar;
    // então reusamos a Order existente e seguimos para (re)criar a Session.
    const order =
      existing ??
      (await this.prisma.order.create({
        data: {
          buyerId,
          eventId,
          organizerId,
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
      }));

    // ─── 5. Email do buyer (réplica local) ───────────────────────────────────
    const buyer = await this.prisma.buyer.findUnique({ where: { id: buyerId } });
    if (!buyer) {
      // Réplica ainda não chegou? Em prod: enfileirar retry; em dev: erro claro.
      throw new InternalServerErrorException(
        'Buyer ainda não replicado do auth-service (tente novamente em alguns segundos)',
      );
    }

    // ─── 6. Stripe Checkout Session ──────────────────────────────────────────
    const lineItems = this.buildLineItems(reservations, serviceFee);

    const session = await this.stripe.checkout.sessions.create(
      {
        payment_method_types: ['card'],
        line_items: lineItems,
        mode: 'payment',
        customer_email: buyer.email,
        success_url: `${this.frontendUrl}/checkout/success?order=${order.id}`,
        cancel_url: `${this.frontendUrl}/checkout/cancel?order=${order.id}`,
        // Checkout expira 1 minuto antes do lock Redis (7 minutos).
        // Stripe exige mínimo de 30 minutos no futuro — ajuste para a janela.
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
      { idempotencyKey },
    );

    await this.prisma.order.update({
      where: { id: order.id },
      data: {
        stripeCheckoutSessionId: session.id,
        stripePaymentIntentId:
          typeof session.payment_intent === 'string' ? session.payment_intent : null,
      },
    });

    // Emitir order.created para observabilidade / frontend polling.
    try {
      await this.kafka.emit(
        KAFKA_TOPICS.ORDER_CREATED,
        {
          orderId: order.id,
          buyerId,
          organizerId,
          eventId,
          total,
        },
        order.id,
      );
    } catch (err) {
      // Commit já aconteceu; log mas não relançar (ver Outbox pattern como
      // solução definitiva para commit-ok/emit-falhou — ver cap-18).
      this.logger.warn('Falha ao emitir order.created', { err: (err as Error).message });
    }

    this.logger.log('Checkout criado', { orderId: order.id, sessionId: session.id });

    return { orderId: order.id, checkoutUrl: session.url ?? '' };
  }

  async getOrder(orderId: string, buyerId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });

    if (!order) {
      throw new NotFoundException('Pedido não encontrado');
    }

    if (order.buyerId !== buyerId) {
      // 404 em vez de 403 para não vazar existência do pedido (OWASP A01)
      throw new NotFoundException('Pedido não encontrado');
    }

    return order;
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private async fetchReservations(
    ids: string[],
    authHeaders: Record<string, string>,
  ): Promise<ReservationSnapshot[]> {
    // N chamadas em paralelo. Para múltiplas reservas seria melhor um endpoint
    // batch, mas na prática o frontend cria 1 reserva por checkout (um evento).
    const results = await Promise.all(
      ids.map(async (id) => {
        const res = await fetch(`${this.bookingServiceUrl}/bookings/reservations/${id}`, {
          headers: authHeaders,
        });
        if (!res.ok) {
          throw new BadRequestException(`Reserva ${id} inválida (status ${res.status})`);
        }
        return res.json() as Promise<ReservationSnapshot>;
      }),
    );
    return results;
  }

  private async getServiceFeePercent(organizerId: string): Promise<number> {
    const organizer = await this.prisma.organizer.findUnique({
      where: { id: organizerId },
      include: { plan: { select: { serviceFeePercent: true } } },
    });

    if (!organizer) {
      // Réplica atrasada: fallback conservador em vez de quebrar o checkout.
      this.logger.warn('Organizer ainda não replicado — usando feePct default', { organizerId });
      return 0;
    }

    return Number(organizer.plan.serviceFeePercent);
  }

  private buildLineItems(
    reservations: ReservationSnapshot[],
    serviceFee: number,
  ): StripeLineItem[] {
    const items: StripeLineItem[] = [];

    for (const r of reservations) {
      for (const item of r.items) {
        items.push({
          price_data: {
            currency: 'brl',
            unit_amount: Math.round(Number(item.unitPrice) * 100), // centavos
            product_data: {
              name: `Ingresso ${item.ticketBatchId.slice(0, 8)}`,
              description: item.seatId ? `Assento ${item.seatId.slice(0, 8)}` : 'Pista',
            },
          },
          quantity: item.quantity,
        });
      }
    }

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
}
