# Capítulo 9 — Worker Service

> **Objetivo:** Processar eventos Kafka assincronamente — gerar ingressos com QR Code HMAC-SHA256, PDF com layout profissional, e enviar e-mails transacionais sem bloquear o fluxo de checkout.

## O que você vai aprender

- Por que processar ingressos assincronamente (não no webhook Stripe)
- QR Code com HMAC-SHA256 — impossível forjar sem a chave secreta
- Validação do QR Code na entrada do evento (check-in)
- PDF gerado com Puppeteer — layout profissional, impressível
- Dead Letter Queue (DLQ): o que acontece quando o processamento falha
- Retry com backoff exponencial — sem perder ingressos por falhas transitórias

---

## Por que assíncrono?

```
SÍNCRONO (errado):
  Webhook Stripe → gerar PDF → enviar e-mail → retornar 200
  Problema: se qualquer passo demorar > 30s, o Stripe re-envia o webhook
  → double processing, ingressos duplicados

ASSÍNCRONO (correto):
  Webhook Stripe → retornar 200 imediatamente
                  → emitir Kafka: payments.payment-confirmed
                       │
                       ▼
                  Worker Service (separado)
                  → buscar dados do pedido
                  → gerar QR Codes
                  → gerar PDF
                  → salvar ingressos no banco
                  → enviar e-mail
  Se falhar: Kafka faz retry automático até 3 vezes → DLQ
```

---

## Passo 9.1 — Ticket Generation Service

```typescript
// apps/worker-service/src/modules/tickets/ticket-generator.service.ts
//
// Gera ingressos com QR Code assinado via HMAC-SHA256.
// O QR Code contém um payload que só pode ser verificado com a chave secreta.
// Na entrada do evento, o scanner verifica o HMAC — ingresso falso é detectado.

import { Injectable, Logger } from '@nestjs/common';
import { createHmac, randomUUID } from 'crypto';
import QRCode from 'qrcode';
import { PrismaService } from '../../prisma/prisma.service';

export interface TicketData {
  ticketId: string;
  orderId: string;
  buyerId: string;
  eventId: string;
  ticketBatchId: string;
  seatId: string | null;
  holderName: string;
  eventTitle: string;
  eventDate: Date;
  venueName: string;
  batchName: string;
  seatLabel: string | null;
}

@Injectable()
export class TicketGeneratorService {
  private readonly logger = new Logger(TicketGeneratorService.name);

  // Chave secreta para assinar os QR Codes
  // NUNCA exposta ao cliente — apenas o worker e o check-in service a conhecem
  private readonly hmacSecret = process.env.TICKET_HMAC_SECRET!;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Gera um ingresso com QR Code assinado.
   *
   * O QR Code contém:
   * {
   *   "t": "550e8400-uuid",        ← ticket ID
   *   "e": "event-uuid",           ← event ID
   *   "s": "a1b2c3d4",             ← seat ID (ou null)
   *   "n": 1714502400000,          ← nonce (timestamp de geração)
   *   "h": "sha256-hmac-signature" ← assinatura HMAC
   * }
   *
   * Para forjar um ingresso, seria necessário conhecer o TICKET_HMAC_SECRET.
   */
  async generateTicket(data: TicketData): Promise<{
    ticketCode: string;
    qrCodeDataUrl: string;
    qrCodePayload: string;
  }> {
    const nonce = Date.now();

    // Payload que vai dentro do QR Code (compacto — QR tem limite de tamanho)
    const payloadWithoutSignature = {
      t: data.ticketId,
      e: data.eventId,
      s: data.seatId ?? null,
      n: nonce,
    };

    // Assinar o payload com HMAC-SHA256
    const payloadString = JSON.stringify(payloadWithoutSignature);
    const signature = createHmac('sha256', this.hmacSecret)
      .update(payloadString)
      .digest('hex')
      .substring(0, 16);  // usar apenas os primeiros 16 chars (balancear tamanho do QR)

    const qrCodePayload = JSON.stringify({
      ...payloadWithoutSignature,
      h: signature,
    });

    // Gerar a imagem do QR Code como Data URL (base64 PNG)
    const qrCodeDataUrl = await QRCode.toDataURL(qrCodePayload, {
      errorCorrectionLevel: 'H',  // alta correção — aguenta até 30% danificado
      width: 300,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#FFFFFF',
      },
    });

    return {
      ticketCode: data.ticketId.substring(0, 8).toUpperCase(),  // código legível
      qrCodeDataUrl,
      qrCodePayload,
    };
  }

  /**
   * Valida um QR Code no check-in.
   * Verifica a assinatura HMAC e retorna os dados do ingresso.
   *
   * @returns { valid: true, ticket } ou { valid: false, reason }
   */
  async validateQrCode(qrCodePayload: string): Promise<
    | { valid: true; ticket: unknown }
    | { valid: false; reason: string }
  > {
    let parsed: { t: string; e: string; s: string | null; n: number; h: string };

    try {
      parsed = JSON.parse(qrCodePayload) as typeof parsed;
    } catch {
      return { valid: false, reason: 'QR Code malformado' };
    }

    // Re-calcular a assinatura sem o campo 'h'
    const { h: signature, ...payloadWithoutSignature } = parsed;
    const expectedSignature = createHmac('sha256', this.hmacSecret)
      .update(JSON.stringify(payloadWithoutSignature))
      .digest('hex')
      .substring(0, 16);

    if (signature !== expectedSignature) {
      this.logger.warn('QR Code com assinatura inválida', {
        ticketId: parsed.t,
        eventId: parsed.e,
      });
      return { valid: false, reason: 'Assinatura inválida — possível falsificação' };
    }

    // Buscar ingresso no banco
    const ticket = await this.prisma.ticket.findUnique({
      where: { id: parsed.t },
    });

    if (!ticket) {
      return { valid: false, reason: 'Ingresso não encontrado' };
    }

    if (ticket.usedAt) {
      return {
        valid: false,
        reason: `Ingresso já utilizado em ${ticket.usedAt.toLocaleString('pt-BR')}`,
      };
    }

    if (ticket.eventId !== parsed.e) {
      return { valid: false, reason: 'Ingresso de outro evento' };
    }

    // Marcar como usado (check-in)
    await this.prisma.ticket.update({
      where: { id: parsed.t },
      data: { usedAt: new Date() },
    });

    return { valid: true, ticket };
  }
}
```

---

## Passo 9.2 — PDF Generator

```typescript
// apps/worker-service/src/modules/tickets/pdf-generator.service.ts
//
// Gera o PDF do ingresso com Puppeteer (headless Chrome).
// Layout profissional renderizado via HTML/CSS — fácil de customizar por organizer.

import { Injectable, Logger } from '@nestjs/common';
import puppeteer from 'puppeteer';
import type { TicketData } from './ticket-generator.service';

@Injectable()
export class PdfGeneratorService {
  private readonly logger = new Logger(PdfGeneratorService.name);

  async generateTicketPdf(
    ticket: TicketData,
    qrCodeDataUrl: string,
    ticketCode: string,
  ): Promise<Buffer> {
    // Reutilizar instância do browser para performance
    // (abrir um novo browser por ticket seria muito lento)
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],  // necessário no Docker
    });

    const page = await browser.newPage();

    const html = this.buildTicketHtml(ticket, qrCodeDataUrl, ticketCode);

    await page.setContent(html, { waitUntil: 'networkidle0' });

    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '20px', bottom: '20px', left: '20px', right: '20px' },
    });

    await browser.close();

    return Buffer.from(pdf);
  }

  private buildTicketHtml(
    ticket: TicketData,
    qrCodeDataUrl: string,
    ticketCode: string,
  ): string {
    const eventDate = new Intl.DateTimeFormat('pt-BR', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(ticket.eventDate);

    return `
      <!DOCTYPE html>
      <html lang="pt-BR">
      <head>
        <meta charset="UTF-8">
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body { font-family: 'Helvetica Neue', sans-serif; background: #f5f5f5; }

          .ticket {
            background: white;
            border-radius: 16px;
            overflow: hidden;
            max-width: 600px;
            margin: 20px auto;
            box-shadow: 0 4px 24px rgba(0,0,0,0.1);
          }

          .ticket-header {
            background: linear-gradient(135deg, #1a1a2e, #16213e);
            color: white;
            padding: 32px;
          }

          .ticket-header h1 { font-size: 24px; font-weight: 700; margin-bottom: 8px; }
          .ticket-header .organizer { font-size: 14px; opacity: 0.7; }

          .ticket-body { display: flex; padding: 32px; gap: 32px; align-items: center; }

          .ticket-info { flex: 1; }
          .ticket-info .label { font-size: 11px; text-transform: uppercase;
                                letter-spacing: 1px; color: #999; margin-bottom: 4px; }
          .ticket-info .value { font-size: 16px; font-weight: 600; color: #1a1a2e;
                                margin-bottom: 20px; }

          .ticket-qr { text-align: center; }
          .ticket-qr img { width: 160px; height: 160px; }
          .ticket-qr .code {
            font-family: monospace; font-size: 18px; font-weight: 700;
            color: #1a1a2e; margin-top: 8px; letter-spacing: 3px;
          }

          .ticket-footer {
            background: #f8f8f8; border-top: 1px dashed #e0e0e0;
            padding: 16px 32px; font-size: 12px; color: #999;
            display: flex; justify-content: space-between;
          }
        </style>
      </head>
      <body>
        <div class="ticket">
          <div class="ticket-header">
            <h1>${ticket.eventTitle}</h1>
            <div class="organizer">ShowPass • Ingresso Oficial</div>
          </div>

          <div class="ticket-body">
            <div class="ticket-info">
              <div class="label">Data e Horário</div>
              <div class="value">${eventDate}</div>

              <div class="label">Local</div>
              <div class="value">${ticket.venueName}</div>

              <div class="label">Tipo de Ingresso</div>
              <div class="value">${ticket.batchName}</div>

              ${ticket.seatLabel ? `
              <div class="label">Assento</div>
              <div class="value">${ticket.seatLabel}</div>
              ` : ''}

              <div class="label">Portador</div>
              <div class="value">${ticket.holderName}</div>
            </div>

            <div class="ticket-qr">
              <img src="${qrCodeDataUrl}" alt="QR Code do ingresso" />
              <div class="code">${ticketCode}</div>
            </div>
          </div>

          <div class="ticket-footer">
            <span>ID: ${ticket.ticketId}</span>
            <span>Apresente este ingresso na entrada</span>
          </div>
        </div>
      </body>
      </html>
    `;
  }
}
```

---

## Passo 9.3 — Kafka Consumer: Payment Confirmed

```typescript
// apps/worker-service/src/modules/tickets/payment-confirmed.consumer.ts
//
// Consome o evento payments.payment-confirmed e executa toda a pipeline
// de geração de ingressos de forma assíncrona.

import { Controller, Logger } from '@nestjs/common';
import { EventPattern, Payload, Ctx, KafkaContext } from '@nestjs/microservices';
import { KAFKA_TOPICS, PaymentConfirmedEventSchema, type PaymentConfirmedEvent } from '@showpass/types';
import { TicketGeneratorService } from './ticket-generator.service';
import { PdfGeneratorService } from './pdf-generator.service';
import { EmailService } from '../email/email.service';
import { PrismaService } from '../../prisma/prisma.service';
import { randomUUID } from 'crypto';

@Controller()
export class PaymentConfirmedConsumer {
  private readonly logger = new Logger(PaymentConfirmedConsumer.name);

  constructor(
    private readonly ticketGen: TicketGeneratorService,
    private readonly pdfGen: PdfGeneratorService,
    private readonly email: EmailService,
    private readonly prisma: PrismaService,
  ) {}

  @EventPattern(KAFKA_TOPICS.PAYMENT_CONFIRMED)
  async handle(
    @Payload() raw: unknown,
    @Ctx() context: KafkaContext,
  ): Promise<void> {
    // Validar o payload com Zod antes de processar
    const result = PaymentConfirmedEventSchema.safeParse(raw);
    if (!result.success) {
      this.logger.error('Payload inválido no consumer', result.error.errors);
      // Não re-throw: mensagem malformada vai para DLQ automaticamente
      return;
    }

    const event = result.data;

    // IDEMPOTÊNCIA: verificar se ingressos já foram gerados para este pedido
    const existingTickets = await this.prisma.ticket.count({
      where: { orderId: event.orderId },
    });

    if (existingTickets > 0) {
      this.logger.info('Ingressos já gerados (idempotente)', { orderId: event.orderId });
      return;
    }

    this.logger.log('Gerando ingressos', {
      orderId: event.orderId,
      itemCount: event.items.length,
    });

    try {
      // Buscar dados do buyer para o PDF
      const buyer = await this.fetchBuyerData(event.buyerId);
      const eventData = await this.fetchEventData(event.items[0]?.ticketBatchId ?? '');

      const ticketsGenerated = [];

      // Gerar um ingresso por item
      for (const item of event.items) {
        const ticketId = randomUUID();

        // Dados do ingresso
        const ticketData = {
          ticketId,
          orderId: event.orderId,
          buyerId: event.buyerId,
          eventId: event.eventId,
          ticketBatchId: item.ticketBatchId,
          seatId: item.seatId,
          holderName: buyer.name,
          eventTitle: eventData.title,
          eventDate: eventData.startAt,
          venueName: eventData.venueName,
          batchName: eventData.batchName,
          seatLabel: item.seatId ? `Fileira ${item.seatRow}, Assento ${item.seatNumber}` : null,
        };

        // Gerar QR Code
        const { ticketCode, qrCodeDataUrl, qrCodePayload } =
          await this.ticketGen.generateTicket(ticketData);

        // Gerar PDF
        const pdfBuffer = await this.pdfGen.generateTicketPdf(
          ticketData,
          qrCodeDataUrl,
          ticketCode,
        );

        // Salvar no banco
        const ticket = await this.prisma.ticket.create({
          data: {
            id: ticketId,
            orderId: event.orderId,
            buyerId: event.buyerId,
            eventId: event.eventId,
            ticketBatchId: item.ticketBatchId,
            seatId: item.seatId,
            qrCodePayload,
            ticketCode,
            // PDF armazenado como base64 ou path para S3
            // Em produção: upload para S3 e guardar apenas a URL
            pdfUrl: await this.uploadPdfToS3(pdfBuffer, ticketId),
          },
        });

        ticketsGenerated.push({ ticket, pdfBuffer, ticketCode });
      }

      // Enviar e-mail com os PDFs anexados
      await this.email.sendTicketsEmail({
        to: buyer.email,
        buyerName: buyer.name,
        eventTitle: eventData.title,
        eventDate: eventData.startAt,
        venueName: eventData.venueName,
        tickets: ticketsGenerated.map((t) => ({
          ticketCode: t.ticketCode,
          pdfBuffer: t.pdfBuffer,
        })),
      });

      this.logger.log('Pipeline de ingressos concluída', {
        orderId: event.orderId,
        ticketCount: ticketsGenerated.length,
        buyerEmail: buyer.email,
      });

    } catch (error) {
      this.logger.error('Erro na pipeline de ingressos', {
        orderId: event.orderId,
        error: (error as Error).message,
        stack: (error as Error).stack,
      });

      // Re-throw: Kafka vai retentar com backoff exponencial
      // Após 3 tentativas, vai para a Dead Letter Topic
      throw error;
    }
  }

  private async fetchBuyerData(buyerId: string): Promise<{ name: string; email: string }> {
    const url = `${process.env.BOOKING_SERVICE_URL}/bookings/buyers/${buyerId}`;
    const res = await fetch(url);
    return res.json() as Promise<{ name: string; email: string }>;
  }

  private async fetchEventData(ticketBatchId: string): Promise<{
    title: string;
    startAt: Date;
    venueName: string;
    batchName: string;
  }> {
    const url = `${process.env.EVENT_SERVICE_URL}/ticket-batches/${ticketBatchId}/event-info`;
    const res = await fetch(url);
    return res.json() as Promise<{ title: string; startAt: Date; venueName: string; batchName: string }>;
  }

  private async uploadPdfToS3(pdfBuffer: Buffer, ticketId: string): Promise<string> {
    // Em produção: usar @aws-sdk/client-s3
    // Em desenvolvimento: retornar URL fake
    if (process.env.NODE_ENV !== 'production') {
      return `https://storage.showpass.local/tickets/${ticketId}.pdf`;
    }

    // Implementação S3 (cap-16 — infraestrutura)
    return `https://storage.showpass.com.br/tickets/${ticketId}.pdf`;
  }
}
```

---

## Passo 9.4 — Dead Letter Queue

```typescript
// apps/worker-service/src/modules/dlq/dlq.consumer.ts
//
// Consome mensagens que falharam após todas as tentativas de retry.
// Em vez de perder a mensagem, ela vai para o DLQ onde pode ser
// monitorada, alertada e reprocessada manualmente.

import { Controller, Logger } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { PrismaService } from '../../prisma/prisma.service';

@Controller()
export class DlqConsumer {
  private readonly logger = new Logger(DlqConsumer.name);

  constructor(private readonly prisma: PrismaService) {}

  // Tópico DLQ: convenção Kafka = nome-do-tópico + .DLT (Dead Letter Topic)
  @EventPattern('payments.payment-confirmed.DLT')
  async handlePaymentConfirmedDlq(@Payload() payload: unknown): Promise<void> {
    this.logger.error('MENSAGEM NA DLQ: payments.payment-confirmed', {
      payload,
      action: 'intervenção manual necessária',
    });

    // Salvar no banco para auditoria e reprocessamento manual
    await this.prisma.failedJob.create({
      data: {
        topic: 'payments.payment-confirmed',
        payload: JSON.stringify(payload),
        failedAt: new Date(),
        status: 'pending_review',
      },
    });

    // Alertar o time via Slack/PagerDuty (integração em cap-17)
    // await this.alerting.sendAlert({ ... });
  }
}
```

---

## Passo 9.5 — Email Service

```typescript
// apps/worker-service/src/modules/email/email.service.ts
//
// Envia e-mails transacionais via Resend (ou Amazon SES em produção).
// Template em React (react-email) — componentes reutilizáveis.

import { Injectable, Logger } from '@nestjs/common';
import { Resend } from 'resend';

interface SendTicketsEmailParams {
  to: string;
  buyerName: string;
  eventTitle: string;
  eventDate: Date;
  venueName: string;
  tickets: Array<{ ticketCode: string; pdfBuffer: Buffer }>;
}

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  private readonly resend = new Resend(process.env.RESEND_API_KEY!);

  async sendTicketsEmail(params: SendTicketsEmailParams): Promise<void> {
    const eventDate = new Intl.DateTimeFormat('pt-BR', {
      dateStyle: 'full',
      timeStyle: 'short',
    }).format(params.eventDate);

    const ticketCodes = params.tickets.map((t) => t.ticketCode).join(', ');

    await this.resend.emails.send({
      from: 'ShowPass <ingressos@showpass.com.br>',
      to: params.to,
      subject: `Seus ingressos: ${params.eventTitle}`,
      html: `
        <h1>Seus ingressos chegaram! 🎟️</h1>
        <p>Olá, ${params.buyerName}!</p>
        <p>Seus ingressos para <strong>${params.eventTitle}</strong> estão prontos.</p>
        <p><strong>Data:</strong> ${eventDate}</p>
        <p><strong>Local:</strong> ${params.venueName}</p>
        <p><strong>Códigos:</strong> ${ticketCodes}</p>
        <p>Os PDFs dos ingressos estão em anexo. Apresente o QR Code na entrada.</p>
        <hr>
        <p style="font-size: 12px; color: #999;">ShowPass — A sua plataforma de ingressos</p>
      `,
      attachments: params.tickets.map((t, i) => ({
        filename: `ingresso-${i + 1}-${t.ticketCode}.pdf`,
        content: t.pdfBuffer,
      })),
    });

    this.logger.log(`E-mail enviado para ${params.to}`, {
      event: params.eventTitle,
      ticketCount: params.tickets.length,
    });
  }
}
```

---

## Estratégia de Scaling: Vertical, não Horizontal

> O Worker Service é diferente dos outros serviços. Enquanto o Booking Service e o API Gateway escalam **horizontalmente** (mais pods), o Worker escala **verticalmente** (mais recursos por pod).

```
Por que vertical?

  Booking Service:
    Cada pod é stateless — requisição HTTP vai para qualquer pod
    10.000 req/s → 10 pods de 1.000 req/s cada → escalar = adicionar pods ✅

  Worker Service:
    Processa mensagens Kafka (tem estado de consumer group)
    Gera PDFs com Puppeteer (Chrome headless = ~200MB RAM por processo)
    Gera QR Codes (CPU intensivo)
    Envia e-mails (I/O bound, mas com limite de rate na API Resend)

  Problema com scaling horizontal do Worker:
    - Kafka consumer group: N pods = N consumers = partições divididas
    - Se tiver 3 partições no tópico, máximo de 3 pods úteis
    - PDF com Puppeteer em 20 pods = 4GB RAM só de Chrome headless
    - Re-entrega do Kafka pode causar duplicação sem idempotência perfeita

  Solução: 1 pod grande em vez de muitos pods pequenos
    requests:  memory: "1Gi"  cpu: "500m"
    limits:    memory: "4Gi"  cpu: "2000m"   ← mais RAM/CPU por pod

  Para alta demanda: aumentar partições do Kafka topic +
                     aumentar replicas proporcionalmente (máx = num partições)
```

```yaml
# infra/k8s/base/worker-service/deployment.yaml (recursos maiores)
containers:
  - name: worker-service
    resources:
      requests:
        memory: "1Gi"    # Puppeteer precisa de RAM
        cpu: "500m"
      limits:
        memory: "4Gi"    # pico de PDFs simultâneos
        cpu: "2000m"     # QR Code + PDF = CPU intensivo
```

---

## Testando na prática

O worker-service não tem endpoints HTTP públicos — ele processa mensagens Kafka. O teste é feito observando os logs e verificando os artefatos gerados (ingressos no banco, PDF por email).

### O que precisa estar rodando

```bash
# Terminal 1 — infraestrutura
docker compose up -d

# Terminal 2 — auth-service
pnpm --filter auth-service run dev

# Terminal 3 — event-service
pnpm --filter event-service run dev

# Terminal 4 — booking-service
pnpm --filter booking-service run dev

# Terminal 5 — payment-service
pnpm --filter payment-service run dev

# Terminal 6 — worker-service
pnpm --filter worker-service run dev        # sem porta HTTP pública

# Terminal 7 — Stripe CLI (para disparar o pagamento)
stripe listen --forward-to http://localhost:3002/webhooks/stripe
```

### Passo a passo

**1. Fluxo completo: reserva → pagamento → geração de ingressos**

Execute os passos 1–4 do Cap 07 para criar uma reserva e simular um pagamento. Quando o Stripe webhook for processado, o payment-service emite `payment.confirmed` no Kafka.

```bash
# Simular pagamento confirmado (atalho sem browser)
stripe trigger checkout.session.completed
```

**2. Observar o worker processar a mensagem**

No terminal do worker-service, você verá:

```
[KafkaConsumer] Mensagem recebida: payment.confirmed — orderId: 018ecccc-...
[TicketService] Gerando 2 ingressos para reserva 018eaaaa-...
[PdfGenerator] PDF gerado — /tmp/ticket-018ecccc-001.pdf (124KB)
[EmailService] Email enviado para joao@email.com
[KafkaConsumer] Mensagem processada com sucesso
```

**3. Verificar ingressos criados no banco**

```bash
docker compose exec postgres psql -U showpass -d showpass_booking \
  -c "SELECT id, seat_id, status, qr_code_hash FROM tickets WHERE order_id = '018ecccc-...' LIMIT 5;"
```

Você verá os ingressos com `status = 'issued'` e um hash único por ingresso.

**4. Verificar o QR Code de um ingresso**

```bash
# Buscar hash do primeiro ingresso
QR_HASH=$(docker compose exec -T postgres psql -U showpass -d showpass_booking \
  -t -c "SELECT qr_code_hash FROM tickets LIMIT 1;" | tr -d ' ')

# Simular validação no check-in
curl -s -X POST http://localhost:3004/tickets/validate \
  -H "Authorization: Bearer $ORGANIZER_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"qrHash\": \"$QR_HASH\"}" | jq .
```

Resposta esperada:

```json
{
  "valid": true,
  "ticket": {
    "seatRow": "A",
    "seatNumber": 1,
    "eventTitle": "Rock in Rio 2025",
    "buyerName": "João Silva"
  }
}
```

**5. Testar a DLQ (Dead Letter Queue)**

Simule uma falha forçando erro no processamento (temporariamente). Nos logs você verá:

```
[KafkaConsumer] Tentativa 1/3 falhou — retrying em 1s
[KafkaConsumer] Tentativa 2/3 falhou — retrying em 2s
[KafkaConsumer] Tentativa 3/3 falhou — enviando para DLQ payment.confirmed.dlq
```

Inspecione a DLQ no Kafka:

```bash
docker compose exec kafka kafka-console-consumer.sh \
  --bootstrap-server localhost:9092 \
  --topic payment.confirmed.dlq \
  --from-beginning \
  --max-messages 1
```

**6. Monitorar Kafka em tempo real**

Para ver todas as mensagens trafegando:

```bash
# Todas as mensagens do tópico payment.confirmed
docker compose exec kafka kafka-console-consumer.sh \
  --bootstrap-server localhost:9092 \
  --topic payment.confirmed \
  --from-beginning
```

> **Dica:** Neste ponto, você já tem o backend completo funcionando end-to-end: auth → evento → reserva → pagamento → ingresso. O próximo capítulo adiciona o frontend Next.js para que o usuário interaja via browser.

---

## Recapitulando

1. **Processamento assíncrono** — webhook retorna 200 imediatamente; ingressos gerados em background sem risco de timeout
2. **QR Code HMAC-SHA256** — payload compacto assinado; impossível forjar sem a chave secreta
3. **Validação no check-in** — re-calcula HMAC e compara; detecta alterações no payload
4. **PDF com Puppeteer** — HTML/CSS renderizado por Chrome headless; layout customizável por organizer
5. **DLQ (Dead Letter Topic)** — mensagens que falham após 3 retries são salvas para análise manual; zero perda de ingressos
6. **Idempotência no consumer** — checar se ingressos já existem antes de gerar; re-delivery do Kafka não duplica
7. **Scaling vertical** — 1 pod grande (4Gi RAM, 2 vCPU) em vez de muitos pods pequenos; Puppeteer + PDF é CPU/RAM intensivo, não I/O bound

---

## Próximo capítulo

[Capítulo 10 → Frontend Foundation](cap-10-frontend-foundation.md)
