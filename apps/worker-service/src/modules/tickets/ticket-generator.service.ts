// apps/worker-service/src/modules/tickets/ticket-generator.service.ts
//
// QR Code com payload assinado HMAC-SHA256. Forjar um ingresso exigiria
// conhecer TICKET_HMAC_SECRET (vive só no worker e no scanner de check-in).

import { Injectable, Logger } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import QRCode from 'qrcode';
import { PrismaService } from '../../prisma/prisma.service.js';

interface QrPayload {
  t: string; // ticketId
  e: string; // eventId
  s: string | null; // seatId
  n: number; // nonce (timestamp de geração)
}

interface SignedQrPayload extends QrPayload {
  h: string; // HMAC-SHA256 truncado a 16 hex chars
}

@Injectable()
export class TicketGeneratorService {
  private readonly logger = new Logger(TicketGeneratorService.name);

  // OBRIGATÓRIO no boot: fail-fast se a secret não existir
  private readonly hmacSecret: string;

  constructor(private readonly prisma: PrismaService) {
    const secret = process.env['TICKET_HMAC_SECRET'];
    if (!secret || secret.length < 32) {
      throw new Error(
        'TICKET_HMAC_SECRET ausente ou < 32 chars — gerar com `openssl rand -hex 32`',
      );
    }
    this.hmacSecret = secret;
  }

  /**
   * Gera QR Code assinado para um ingresso já criado.
   * Retorna data URL (base64 PNG) + payload textual (para revalidação).
   */
  async generate(input: {
    ticketId: string;
    eventId: string;
    seatId: string | null;
  }): Promise<{
    qrCodePayload: string;
    qrCodeDataUrl: string;
    ticketCode: string;
  }> {
    const payload: QrPayload = {
      t: input.ticketId,
      e: input.eventId,
      s: input.seatId,
      n: Date.now(),
    };

    const signature = this.sign(payload);
    const signed: SignedQrPayload = { ...payload, h: signature };

    const qrCodePayload = JSON.stringify(signed);
    const qrCodeDataUrl = await QRCode.toDataURL(qrCodePayload, {
      errorCorrectionLevel: 'H', // tolera até 30% de dano físico
      width: 300,
      margin: 2,
    });

    // Código humano (8 chars uppercase) — uppercase do início do UUID
    const ticketCode = input.ticketId
      .replace(/-/g, '')
      .slice(0, 8)
      .toUpperCase();

    return { qrCodePayload, qrCodeDataUrl, ticketCode };
  }

  /**
   * Valida um QR Code no check-in.
   * parse JSON → re-calcula HMAC → bate com h? → busca no banco
   * → ainda não usado? → marca como usado.
   */
  async validate(
    qrCodePayload: string,
  ): Promise<
    | { valid: true; ticket: { id: string; eventId: string; ticketCode: string } }
    | { valid: false; reason: string }
  > {
    let parsed: SignedQrPayload;
    try {
      parsed = JSON.parse(qrCodePayload) as SignedQrPayload;
    } catch {
      return { valid: false, reason: 'QR Code malformado' };
    }

    const { h: signature, ...rest } = parsed;
    const expected = this.sign(rest);

    if (signature !== expected) {
      this.logger.warn('Assinatura inválida — possível falsificação', {
        ticketId: parsed.t,
      });
      return { valid: false, reason: 'Assinatura inválida' };
    }

    const ticket = await this.prisma.ticket.findUnique({
      where: { id: parsed.t },
    });
    if (!ticket) return { valid: false, reason: 'Ingresso não encontrado' };
    if (ticket.eventId !== parsed.e)
      return { valid: false, reason: 'Ingresso de outro evento' };
    if (ticket.usedAt)
      return {
        valid: false,
        reason: `Já utilizado em ${ticket.usedAt.toISOString()}`,
      };

    await this.prisma.ticket.update({
      where: { id: ticket.id },
      data: { usedAt: new Date() },
    });

    return {
      valid: true,
      ticket: {
        id: ticket.id,
        eventId: ticket.eventId,
        ticketCode: ticket.ticketCode,
      },
    };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private sign(payload: QrPayload): string {
    return createHmac('sha256', this.hmacSecret)
      .update(JSON.stringify(payload))
      .digest('hex')
      .substring(0, 16); // 64 bits — suficiente contra brute force online
  }
}
