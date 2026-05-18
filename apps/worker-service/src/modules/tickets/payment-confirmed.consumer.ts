// apps/worker-service/src/modules/tickets/payment-confirmed.consumer.ts
//
// Coração do worker: valida → idempotência → carrega réplicas → gera
// Ticket+QR+PDF por unidade → e-mail (best-effort) → DLT em falha.

import { Controller, Logger } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { randomUUID } from 'node:crypto';

import { KAFKA_TOPICS, PaymentConfirmedEventSchema } from '@showpass/types';
import { KafkaProducerService } from '@showpass/kafka';

import { PrismaService } from '../../prisma/prisma.service.js';
import { TicketGeneratorService } from './ticket-generator.service.js';
import { PdfGeneratorService } from './pdf-generator.service.js';
import { EmailService } from '../email/email.service.js';
import { PdfStorageService } from './pdf-storage.service.js';

const DLT_TOPIC = `${KAFKA_TOPICS.PAYMENT_CONFIRMED}.dlt`;

@Controller()
export class PaymentConfirmedConsumer {
  private readonly logger = new Logger(PaymentConfirmedConsumer.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ticketGen: TicketGeneratorService,
    private readonly pdfGen: PdfGeneratorService,
    private readonly email: EmailService,
    private readonly storage: PdfStorageService,
    private readonly kafka: KafkaProducerService,
  ) {}

  @EventPattern(KAFKA_TOPICS.PAYMENT_CONFIRMED)
  async handle(@Payload() raw: unknown): Promise<void> {
    // ─── 1. Validar payload ───────────────────────────────────────────────
    const parsed = PaymentConfirmedEventSchema.safeParse(raw);
    if (!parsed.success) {
      this.logger.error('Payload inválido — descartando para DLT', {
        issues: parsed.error.issues,
      });
      // Malformado: relançar não adianta (falha de novo). Direto pra DLT.
      await this.sendToDlt(raw, new Error('Schema validation failed'));
      return;
    }

    const event = parsed.data;

    // ─── 2. Idempotência ──────────────────────────────────────────────────
    // Kafka at-least-once: a mesma mensagem pode chegar 2x. Tickets já
    // gerados = não regerar (2x QR Codes válidos = fraude).
    const already = await this.prisma.ticket.count({
      where: { orderId: event.orderId },
    });
    if (already > 0) {
      this.logger.log('Tickets já gerados — idempotente', {
        orderId: event.orderId,
        count: already,
      });
      return;
    }

    // ─── 3. Carregar contexto das réplicas locais ─────────────────────────
    const [buyer, eventData, batches] = await Promise.all([
      this.prisma.buyer.findUnique({ where: { id: event.buyerId } }),
      this.prisma.event.findUnique({ where: { id: event.eventId } }),
      this.prisma.ticketBatch.findMany({
        where: { id: { in: event.items.map((i) => i.ticketBatchId) } },
      }),
    ]);

    // Réplicas Kafka são eventually consistent. Se o consumer for mais
    // rápido que a replicação, re-throw força retry (Kafka reentrega).
    if (!buyer || !eventData) {
      const missing = [!buyer && 'buyer', !eventData && 'event']
        .filter(Boolean)
        .join(', ');
      this.logger.warn(
        `Réplica local ausente (${missing}) — relançando para retry`,
        { orderId: event.orderId },
      );
      throw new Error(`Replicas not yet synchronized: ${missing}`);
    }

    const batchById = new Map(batches.map((b) => [b.id, b]));

    // ─── 4. Gerar tickets ─────────────────────────────────────────────────
    try {
      const generated: Array<{ ticketCode: string; pdfBuffer: Buffer }> = [];

      for (const item of event.items) {
        // 1 ticket por unidade — general admission com quantity=3 → 3 tickets
        for (let i = 0; i < item.quantity; i++) {
          const ticketId = randomUUID();

          const { qrCodePayload, qrCodeDataUrl, ticketCode } =
            await this.ticketGen.generate({
              ticketId,
              eventId: event.eventId,
              seatId: item.seatId,
            });

          const batch = batchById.get(item.ticketBatchId);
          const pdfBuffer = await this.pdfGen.generate({
            ticketId,
            ticketCode,
            qrCodeDataUrl,
            eventTitle: eventData.title,
            eventDate: eventData.startAt,
            venueName: `${eventData.venueCity} / ${eventData.venueState}`,
            batchName: batch?.name ?? 'Ingresso',
            // seatLabel real exigiria réplica de Seat (não fizemos —
            // event-service mantém Seat localmente, sem replicação).
            seatLabel: item.seatId
              ? `Assento ${item.seatId.slice(0, 8).toUpperCase()}`
              : null,
            holderName: buyer.name,
          });

          const pdfUrl = await this.storage.upload(pdfBuffer, ticketId);

          await this.prisma.ticket.create({
            data: {
              id: ticketId,
              orderId: event.orderId,
              buyerId: event.buyerId,
              eventId: event.eventId,
              ticketBatchId: item.ticketBatchId,
              seatId: item.seatId,
              qrCodePayload,
              ticketCode,
              pdfUrl,
            },
          });

          generated.push({ ticketCode, pdfBuffer });
        }
      }

      // ─── 5. E-mail (best-effort: falha aqui não revoga tickets) ─────────
      try {
        await this.email.sendTickets({
          to: buyer.email,
          buyerName: buyer.name,
          eventTitle: eventData.title,
          eventDate: eventData.startAt,
          venueName: `${eventData.venueCity} / ${eventData.venueState}`,
          tickets: generated,
        });
      } catch (err) {
        // E-mail falhou MAS tickets já estão no banco — reenvio é tarefa
        // separada. Logar e seguir.
        this.logger.error('Falha ao enviar e-mail (tickets emitidos OK)', {
          orderId: event.orderId,
          error: (err as Error).message,
        });
      }

      this.logger.log('Pipeline concluída', {
        orderId: event.orderId,
        ticketCount: generated.length,
      });
    } catch (err) {
      // ─── 6. Falha não-recuperável → DLT ────────────────────────────────
      // Versão simplificada: 1ª falha que chega no catch vai pra DLT direto.
      // Versão produção: contar attempts no Redis e só DLT após N.
      this.logger.error('Falha na pipeline — enviando para DLT', {
        orderId: event.orderId,
        error: (err as Error).message,
      });
      await this.sendToDlt(event, err as Error);
      // NÃO relançar: relançar deixaria a mensagem na partição em loop.
    }
  }

  /**
   * Envia para o tópico .dlt + persiste FailedJob para auditoria.
   */
  private async sendToDlt(payload: unknown, err: Error): Promise<void> {
    try {
      await this.kafka.emit(
        // KAFKA_TOPICS é `as const`; emit só aceita topics declarados.
        // Em prod, adicionar PAYMENT_CONFIRMED_DLT ao enum para type-safety.
        DLT_TOPIC as never,
        {
          original: payload,
          error: err.message,
          occurredAt: new Date().toISOString(),
        },
      );
    } catch (emitErr) {
      this.logger.error(
        'Falha ao emitir DLT — fallback só em FailedJob',
        emitErr,
      );
    }

    await this.prisma.failedJob.create({
      data: {
        topic: KAFKA_TOPICS.PAYMENT_CONFIRMED,
        // Json aceita qualquer objeto serializável
        payload: payload as object,
        errorMessage: err.message,
        status: 'pending_review',
      },
    });
  }
}
