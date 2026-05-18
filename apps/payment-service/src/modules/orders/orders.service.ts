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
import type { Prisma } from '../../prisma/generated/index.js';

// Fail-fast de envs obrigatórios (substitui o non-null assertion `!`,
// proibido pelo lint — e dá erro claro em vez de "invalid api key").
function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  return v;
}

const STRIPE_SECRET_KEY = requireEnv('STRIPE_SECRET_KEY');
const FRONTEND_URL = process.env['FRONTEND_URL'] ?? '';

type OrderWithItems = Prisma.OrderGetPayload<{ include: { items: true } }>;

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

  private readonly stripe = new Stripe(STRIPE_SECRET_KEY, {
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
    // fetchReservations já garante length > 0; o guard abaixo satisfaz o
    // type narrowing sem non-null assertion (proibido pelo lint).
    const [first] = reservations;
    if (!first) {
      throw new BadRequestException('Nenhuma reserva fornecida');
    }
    const organizerId = first.organizerId;
    const eventId = first.eventId;

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
        success_url: `${FRONTEND_URL}/checkout/success?order=${order.id}`,
        cancel_url: `${FRONTEND_URL}/checkout/cancel?order=${order.id}`,
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
    const base = process.env['BOOKING_SERVICE_URL'] ?? 'http://localhost:3004';

    const results = await Promise.all(
      ids.map(async (id) => {
        const res = await fetch(`${base}/bookings/reservations/${id}`, {
          headers: authHeaders,
        });
        if (!res.ok) {
          throw new BadRequestException(
            `Reserva ${id} inacessível (${String(res.status)})`,
          );
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