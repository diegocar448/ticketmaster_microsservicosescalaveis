// apps/payment-service/src/modules/webhooks/webhooks.controller.ts
//
// Recebe webhooks do Stripe. Dois princípios críticos:
//
// 1. OWASP A10 — verificação HMAC antes de processar:
//    Stripe assina cada webhook com HMAC-SHA256. Validamos no MESMO
//    endpoint (não em middleware) porque precisamos do req.rawBody.
//    Sem validação, qualquer um poderia POST /webhooks/stripe e confirmar
//    pagamentos falsos.
//
// 2. Idempotência — Stripe re-envia o mesmo evento múltiplas vezes
//    (até 3 dias em caso de falha). Processar duas vezes = cobrar/emitir
//    ingresso duas vezes. Checamos `order.status === 'paid'` antes de
//    processar novamente.
//
// Por que @Controller('webhooks') direto e não via gateway? O Stripe precisa
// alcançar o endpoint publicamente. Em dev usamos `stripe listen` que forwarda
// para localhost. Em prod: ingress dedicado apontando direto ao payment-service
// (pular o gateway evita risco do gateway reprocessar/parsear o body).

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

// Fail-fast de envs obrigatórios (substitui non-null assertion `!`).
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
    const orderId = session.metadata?.['order_id'];
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
        stripeChargeId: charge?.id ?? null,
        paymentMethod: charge?.payment_method_details?.type ?? 'card',
        cardLastFour: charge?.payment_method_details?.card?.last4 ?? null,
        cardBrand: charge?.payment_method_details?.card?.brand ?? null,
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
    // Stripe.PaymentIntent.metadata é sempre presente (Stripe.Metadata),
    // não nullable — optional chain era desnecessário (no-unnecessary-condition).
    const orderId = paymentIntent.metadata['order_id'];
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
    const orderId = session.metadata?.['order_id'];
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
    // Stripe.Charge.metadata é sempre presente (Stripe.Metadata), não nullable.
    const orderId = charge.metadata['order_id'];
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