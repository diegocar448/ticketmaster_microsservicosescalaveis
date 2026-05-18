// apps/worker-service/src/modules/email/email.service.ts
//
// E-mail transacional via Resend. Em prod real, considerar Amazon SES.

import { Injectable, Logger } from '@nestjs/common';
import { Resend } from 'resend';

interface SendTicketsParams {
  to: string;
  buyerName: string | null;
  eventTitle: string;
  eventDate: Date;
  venueName: string;
  tickets: Array<{ ticketCode: string; pdfBuffer: Buffer }>;
}

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly resend: Resend;

  constructor() {
    const key = process.env['RESEND_API_KEY'];
    if (!key) throw new Error('RESEND_API_KEY ausente');
    this.resend = new Resend(key);
  }

  async sendTickets(params: SendTicketsParams): Promise<void> {
    const date = new Intl.DateTimeFormat('pt-BR', {
      dateStyle: 'full',
      timeStyle: 'short',
    }).format(params.eventDate);

    const codes = params.tickets.map((t) => t.ticketCode).join(', ');
    const greeting = params.buyerName ? `Olá, ${params.buyerName}!` : 'Olá!';

    await this.resend.emails.send({
      from: 'ShowPass <ingressos@showpass.com.br>',
      to: params.to,
      subject: `Seus ingressos: ${params.eventTitle}`,
      html: `
        <h1>Seus ingressos chegaram!</h1>
        <p>${greeting}</p>
        <p>Seus ingressos para <strong>${params.eventTitle}</strong> estão prontos.</p>
        <p><strong>Data:</strong> ${date}</p>
        <p><strong>Local:</strong> ${params.venueName}</p>
        <p><strong>Códigos:</strong> ${codes}</p>
        <p>Os PDFs dos ingressos estão em anexo. Apresente o QR Code na entrada.</p>
      `,
      attachments: params.tickets.map((t, i) => ({
        filename: `ingresso-${String(i + 1)}-${t.ticketCode}.pdf`,
        content: t.pdfBuffer,
      })),
    });

    this.logger.log(`E-mail enviado para ${params.to}`, {
      ticketCount: params.tickets.length,
    });
  }
}
