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
  BadRequestException,
  Controller,
  HttpCode,
  Logger,
  Post,
  Req,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { KafkaProducerService } from '@showpass/kafka';
import { KAFKA_TOPICS } from '@showpass/types';
import Stripe from 'stripe';

import { PrismaService } from '../../prisma/prisma.service.js';

@Controller('webhooks')
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);
  private readonly stripe: Stripe;
  private readonly webhookSecret: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly kafka: KafkaProducerService,
  ) {
    const apiKey = process.env['STRIPE_SECRET_KEY'];
    const secret = process.env['STRIPE_WEBHOOK_SECRET'];
    if (!apiKey || !secret) {
      throw new Error('STRIPE_SECRET_KEY ou STRIPE_WEBHOOK_SECRET não configurados');
    }
    this.stripe = new Stripe(apiKey);
    this.webhookSecret = secret;
  }

  @Post('stripe')
  @HttpCode(200) // Stripe interpreta qualquer != 200 como falha e retenta
  async handleStripe(
    @Req() req: RawBodyRequest<Request>,
  ): Promise<{ received: boolean }> {
    const signature = req.headers['stripe-signature'];
    if (!signature || Array.isArray(signature)) {
      throw new BadRequestException('Assinatura ausente');
    }

    if (!req.rawBody) {
      // Se cair aqui, o main.ts está mal configurado (rawBody: true ausente).
      throw new BadRequestException('Raw body indisponível');
    }

    let event: Stripe.Event;
    try {
      // constructEvent verifica HMAC E timestamp (rejeita > 5 minutos → replay).
      event = this.stripe.webhooks.constructEvent(
        req.rawBody,
        signature,
        this.webhookSecret,
      );
    } catch (err) {
      this.logger.warn('Assinatura Stripe inválida', { err: (err as Error).message });
      throw new BadRequestException('Assinatura inválida');
    }

    this.logger.log(`Webhook recebido: ${event.type}`, { eventId: event.id });

    switch (event.type) {
      case 'checkout.session.completed':
        await this.handleCheckoutCompleted(event.data.object);
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

  // ─── Handlers ──────────────────────────────────────────────────────────────

  // checkout.session.completed é o evento estável do Stripe para "pagamento
  // OK em fluxo de Checkout". payment_intent.succeeded também é emitido, mas
  // processar os dois seria duplicar. Escolhemos checkout.session.completed
  // porque carrega os metadados que setamos na session.
  private async handleCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
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

    // Idempotência: se já foi processado, ignorar silenciosamente.
    if (order.status === 'paid') {
      this.logger.log('Webhook ignorado: pedido já pago', { orderId });
      return;
    }

    // Retrieve expandido para pegar dados do Payment Intent (cartão etc).
    const paymentIntentId =
      typeof session.payment_intent === 'string' ? session.payment_intent : null;

    let chargeId: string | null = null;
    let paymentMethod: string | null = null;
    let cardLastFour: string | null = null;
    let cardBrand: string | null = null;

    if (paymentIntentId) {
      const pi = await this.stripe.paymentIntents.retrieve(paymentIntentId, {
        expand: ['latest_charge'],
      });
      const charge = pi.latest_charge as Stripe.Charge | null;
      chargeId = charge?.id ?? null;
      paymentMethod = charge?.payment_method_details?.type ?? null;
      cardLastFour = charge?.payment_method_details?.card?.last4 ?? null;
      cardBrand = charge?.payment_method_details?.card?.brand ?? null;
    }

    const paidAt = new Date();

    await this.prisma.order.update({
      where: { id: orderId },
      data: {
        status: 'paid',
        stripeChargeId: chargeId,
        paymentMethod,
        cardLastFour,
        cardBrand,
        paidAt,
      },
    });

    // Emitir para o worker-service gerar ingressos + enviar e-mail (cap-09).
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
        paidAt,
      },
      order.id,
    );

    this.logger.log('Pagamento confirmado', { orderId, total: order.total.toString() });
  }

  private async handlePaymentFailed(pi: Stripe.PaymentIntent): Promise<void> {
    const orderId = pi.metadata['order_id'];
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
