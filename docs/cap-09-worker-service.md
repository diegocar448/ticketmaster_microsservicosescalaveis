# Capítulo 9 — Worker Service

> **Objetivo:** Processar `payments.payment-confirmed` assincronamente — gerar ingressos com QR Code HMAC-SHA256, PDF com Puppeteer, e enviar e-mail transacional sem bloquear a resposta ao Stripe.

## O que você vai aprender

- Por que processar ingressos **fora** do webhook do Stripe (timeout de 5s)
- Schema Prisma do worker — modelos `Ticket`, `FailedJob` + réplicas Kafka
- QR Code com HMAC-SHA256 — assinatura impossível de forjar sem a chave
- Validação no check-in (re-cálculo do HMAC + lookup no banco)
- PDF com Puppeteer reusando uma instância de Browser (singleton)
- DLQ **real** (não automática) — try/catch + producer manual + auditoria
- Idempotência no consumer — Kafka at-least-once exige

---

## Pré-requisito — corrigir o `PaymentConfirmedEventSchema`

> **Antes de implementar este capítulo**, garanta que o contrato em
> [packages/types/src/kafka-topics.ts](../packages/types/src/kafka-topics.ts)
> inclui `eventId` (envelope) e `quantity` (item). Sem isso, o Zod
> `safeParse()` faz `.strip()` silencioso e o consumer recebe `undefined`
> nesses campos.

```typescript
// packages/types/src/kafka-topics.ts (trecho)

export const PaymentConfirmedEventSchema = z.object({
  orderId: z.uuid(),
  buyerId: z.uuid(),
  organizerId: z.uuid(),
  eventId: z.uuid(),                            // ← eventId obrigatório
  items: z.array(
    z.object({
      reservationId: z.uuid(),
      ticketBatchId: z.uuid(),
      seatId: z.uuid().nullable(),
      unitPrice: z.number(),
      quantity: z.number().int().positive(),    // ← quantity obrigatório
    })
  ),
  paidAt: z.coerce.date(),
});
```

O emitter ([payment-service/webhooks.controller.ts](../apps/payment-service/src/modules/webhooks/webhooks.controller.ts) — `handleSessionCompleted`) já envia ambos.

---

## Por que processamento assíncrono?

```
SÍNCRONO (errado):
  Webhook Stripe → buscar reserva → gerar QR → renderizar PDF → enviar email → 200
  Problema: o Stripe espera 200 em < 5s. Puppeteer + Resend juntos passam disso
            facilmente. Stripe re-envia o webhook → cobra/processa em duplicado.

ASSÍNCRONO (correto):
  Webhook Stripe → atualizar order → emit Kafka → 200 (em < 100ms)
                                         │
                                         ▼
                         Worker consome payments.payment-confirmed
                         → gerar QR Codes
                         → renderizar PDFs
                         → persistir tickets
                         → enviar e-mail
                         (até 30s — quem tá esperando é o Kafka, não o Stripe)
```

---

## Passo 9.0 — Schema Prisma

O worker tem o **menor schema** do projeto: apenas `Ticket` (owned) +
`FailedJob` (auditoria de DLQ) + duas réplicas locais (Buyer e Event) para
montar e-mail/PDF sem chamar HTTP cross-service.

```prisma
// apps/worker-service/prisma/schema.prisma

generator client {
  provider = "prisma-client-js"
  output   = "../src/prisma/generated"
}

datasource db {
  provider = "postgresql"
}

// ─── Ticket (owned pelo worker-service) ───────────────────────────────────────
//
// Source of truth dos ingressos emitidos. payment-service e booking-service
// não escrevem aqui — só este serviço gera tickets, somente a partir de
// payments.payment-confirmed.
model Ticket {
  id String @id @default(uuid()) @db.Uuid

  // FKs lógicas (sem constraint cross-service)
  orderId       String  @db.Uuid
  buyerId       String  @db.Uuid
  eventId       String  @db.Uuid
  ticketBatchId String  @db.Uuid
  seatId        String? @db.Uuid

  // QR Code: payload completo assinado com HMAC-SHA256.
  // Guardamos o JSON inteiro (~120 bytes) para revalidar no check-in
  // sem precisar reconstruir o objeto a partir de partes.
  qrCodePayload String

  // Código humano (8 chars uppercase) — fácil de soletrar/exibir.
  ticketCode String @db.Char(8)

  // PDF: em dev, URL fake; em prod, S3 com lifecycle de 1 ano.
  pdfUrl String?

  // Marca o uso no check-in. NULL = ainda não usado.
  // Tornar UNIQUE não é correto: se o ingresso for invalidado por refund,
  // queremos manter histórico. Em vez disso, validateQrCode rejeita usedAt != null.
  usedAt DateTime?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  // orderId não é unique: 1 order pode gerar N tickets (1 por item.quantity)
  @@index([orderId])
  @@index([buyerId])
  @@index([eventId, usedAt])
  @@map("tickets")
}

// ─── FailedJob (auditoria de DLQ) ─────────────────────────────────────────────
//
// Registro append-only de mensagens que esgotaram retries. Permite reprocessar
// manualmente após corrigir o bug que causou a falha. Status muda apenas
// pending_review → reprocessed (ou abandoned).
model FailedJob {
  id String @id @default(uuid()) @db.Uuid

  topic        String    // ex: "payments.payment-confirmed"
  payload      Json      // mensagem original — para reprocessamento
  errorMessage String?
  attempts     Int       @default(1)

  status     String   @default("pending_review")  // pending_review | reprocessed | abandoned
  failedAt   DateTime @default(now())
  reviewedAt DateTime?

  @@index([topic, status])
  @@index([failedAt])
  @@map("failed_jobs")
}

// ─── Buyer (replicado de auth-service via Kafka) ──────────────────────────────
//
// Existe aqui para o e-mail (precisa do email + name) sem fazer round-trip HTTP
// no path quente do consumer. Mesma semântica das réplicas em booking/payment.
// passwordHash NUNCA trafega.
model Buyer {
  id    String  @id @db.Uuid
  email String  @unique
  name  String?

  lastSyncAt DateTime?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@map("buyers")
}

// ─── Event (replicado de event-service via Kafka) ────────────────────────────
//
// Réplica local do título + venue para popular PDF e e-mail. Mesma estratégia
// do booking-service (cap-06 Passo 6.11).
model Event {
  id          String @id @db.Uuid
  organizerId String @db.Uuid

  title String
  slug  String @unique

  startAt DateTime
  endAt   DateTime

  venueCity  String
  venueState String

  thumbnailUrl String?
  lastSyncAt   DateTime @default(now())

  @@map("events")
}

// ─── TicketBatch (replicado de event-service) ────────────────────────────────
//
// Apenas o nome — usado na descrição do PDF/e-mail ("Pista Premium", "Camarote").
model TicketBatch {
  id      String @id @db.Uuid
  eventId String @db.Uuid
  name    String

  lastSyncAt DateTime @default(now())

  @@index([eventId])
  @@map("ticket_batches")
}
```

Migration:

```bash
pnpm --filter @showpass/worker-service run db:generate
pnpm --filter @showpass/worker-service run db:migrate -- --name init
```

---

## Passo 9.1 — Consumers Kafka das réplicas

Mesmo padrão dos consumers do payment-service (cap-07): Zod safe-parse +
upsert idempotente. Replica `Buyer`, `Event` e `TicketBatch` localmente.

```typescript
// apps/worker-service/src/modules/replicas/buyers.consumer.ts

import { Controller, Logger } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { KAFKA_TOPICS, BuyerReplicatedEventSchema } from '@showpass/types';
import { PrismaService } from '../../prisma/prisma.service.js';

@Controller()
export class BuyersConsumer {
  private readonly logger = new Logger(BuyersConsumer.name);
  constructor(private readonly prisma: PrismaService) {}

  @EventPattern(KAFKA_TOPICS.AUTH_BUYER_CREATED)
  async onCreated(@Payload() raw: unknown): Promise<void> {
    return this.upsert(raw, 'AUTH_BUYER_CREATED');
  }

  @EventPattern(KAFKA_TOPICS.AUTH_BUYER_UPDATED)
  async onUpdated(@Payload() raw: unknown): Promise<void> {
    return this.upsert(raw, 'AUTH_BUYER_UPDATED');
  }

  private async upsert(raw: unknown, topic: string): Promise<void> {
    const parsed = BuyerReplicatedEventSchema.safeParse(raw);
    if (!parsed.success) {
      this.logger.warn(`${topic} inválido`, { issues: parsed.error.issues });
      return;
    }
    const { id, email, name } = parsed.data;
    await this.prisma.buyer.upsert({
      where:  { id },
      create: { id, email, name, lastSyncAt: new Date() },
      update: {     email, name, lastSyncAt: new Date() },
    });
  }
}
```

```typescript
// apps/worker-service/src/modules/replicas/events.consumer.ts

import { Controller, Logger } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { KAFKA_TOPICS, EventReplicatedEventSchema } from '@showpass/types';
import { PrismaService } from '../../prisma/prisma.service.js';

@Controller()
export class EventsConsumer {
  private readonly logger = new Logger(EventsConsumer.name);
  constructor(private readonly prisma: PrismaService) {}

  @EventPattern(KAFKA_TOPICS.EVENT_PUBLISHED)
  async onPublished(@Payload() raw: unknown): Promise<void> {
    return this.upsert(raw, 'EVENT_PUBLISHED');
  }

  @EventPattern(KAFKA_TOPICS.EVENT_UPDATED)
  async onUpdated(@Payload() raw: unknown): Promise<void> {
    return this.upsert(raw, 'EVENT_UPDATED');
  }

  private async upsert(raw: unknown, topic: string): Promise<void> {
    const parsed = EventReplicatedEventSchema.safeParse(raw);
    if (!parsed.success) {
      this.logger.warn(`${topic} inválido`, { issues: parsed.error.issues });
      return;
    }
    const e = parsed.data;
    await this.prisma.event.upsert({
      where:  { id: e.id },
      create: {
        id: e.id, organizerId: e.organizerId, title: e.title, slug: e.slug,
        startAt: e.startAt, endAt: e.endAt,
        venueCity: e.venueCity, venueState: e.venueState,
        thumbnailUrl: e.thumbnailUrl,
      },
      update: {
        organizerId: e.organizerId, title: e.title, slug: e.slug,
        startAt: e.startAt, endAt: e.endAt,
        venueCity: e.venueCity, venueState: e.venueState,
        thumbnailUrl: e.thumbnailUrl,
        lastSyncAt: new Date(),
      },
    });
  }
}
```

(O `TicketBatchesConsumer` segue o mesmo molde — consome
`events.ticket-batch-*` e replica só `id, eventId, name`.)

---

## Passo 9.2 — `TicketGeneratorService` (QR Code HMAC)

O QR Code carrega um payload **assinado** com HMAC-SHA256. Para forjar um
ingresso, seria necessário conhecer `TICKET_HMAC_SECRET` — que vive **só** no
worker e no scanner de check-in.

```typescript
// apps/worker-service/src/modules/tickets/ticket-generator.service.ts

import { Injectable, Logger } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import QRCode from 'qrcode';
import { PrismaService } from '../../prisma/prisma.service.js';

interface QrPayload {
  t: string;          // ticketId
  e: string;          // eventId
  s: string | null;   // seatId
  n: number;          // nonce (timestamp de geração)
}

interface SignedQrPayload extends QrPayload {
  h: string;          // HMAC-SHA256 truncado a 16 hex chars
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
  }): Promise<{ qrCodePayload: string; qrCodeDataUrl: string; ticketCode: string }> {
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
    const ticketCode = input.ticketId.replace(/-/g, '').slice(0, 8).toUpperCase();

    return { qrCodePayload, qrCodeDataUrl, ticketCode };
  }

  /**
   * Valida um QR Code no check-in.
   * Sequência: parse JSON → re-calcula HMAC → bate com h? → busca no banco
   * → ainda não usado? → marcar como usado.
   *
   * Em uso real, este método vive em um endpoint HTTP separado (no próprio
   * worker ou em um check-in-service dedicado). Aqui é apresentado junto por
   * coesão didática.
   */
  async validate(qrCodePayload: string): Promise<
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

    const ticket = await this.prisma.ticket.findUnique({ where: { id: parsed.t } });
    if (!ticket)              return { valid: false, reason: 'Ingresso não encontrado' };
    if (ticket.eventId !== parsed.e)
                              return { valid: false, reason: 'Ingresso de outro evento' };
    if (ticket.usedAt)        return { valid: false, reason: `Já utilizado em ${ticket.usedAt.toISOString()}` };

    await this.prisma.ticket.update({
      where: { id: ticket.id },
      data:  { usedAt: new Date() },
    });

    return {
      valid: true,
      ticket: { id: ticket.id, eventId: ticket.eventId, ticketCode: ticket.ticketCode },
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
```

> **Por que truncar HMAC para 16 chars?** O QR Code tem limite prático de
> ~700 bytes. HMAC-SHA256 completo são 64 chars hex. Truncar para 16 chars
> (64 bits) ainda dá ~10¹⁹ combinações — inviável para forjar online (com
> rate limit no scanner). Em sistemas com requisitos forenses mais altos,
> usar a assinatura completa.

---

## Passo 9.3 — `PdfGeneratorService` (Puppeteer com Browser singleton)

> **Atenção — `puppeteer` arrasta dependências vulneráveis (OWASP A06).**
> Adicionar `puppeteer` ao `worker-service` puxa a cadeia
> `puppeteer → @puppeteer/browsers → proxy-agent → pac-proxy-agent → get-uri
> → basic-ftp`. O `basic-ftp` < 5.3.1 tem CVE **high** (DoS) e **faz o passo
> `Security Audit` do CI falhar** (`pnpm audit --audit-level=high`). A correção
> é o `pnpm.overrides` no `package.json` raiz (`"basic-ftp": ">=5.3.1"`) —
> mesmo mecanismo do `tar`/`axios`. Ver **cap-15 → "Passando no gate
> `pnpm audit`"**. Depois de adicionar puppeteer: `pnpm install` + confirmar
> `pnpm audit --audit-level=high` (exit 0) e commitar o `pnpm-lock.yaml`.

Puppeteer abre uma instância de Chromium headless por **chamada** se você
não cuidar — cada launch leva ~1.5s e ~200MB de RAM. A solução é manter
**um único Browser** vivo durante a vida do módulo, criando apenas `Page`s
sob demanda.

```typescript
// apps/worker-service/src/modules/tickets/pdf-generator.service.ts

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import puppeteer, { type Browser } from 'puppeteer';

export interface TicketRenderInput {
  ticketCode: string;
  qrCodeDataUrl: string;
  eventTitle: string;
  eventDate: Date;
  venueName: string;
  batchName: string;
  seatLabel: string | null;
  holderName: string | null;
  ticketId: string;
}

@Injectable()
export class PdfGeneratorService implements OnModuleDestroy {
  private readonly logger = new Logger(PdfGeneratorService.name);

  // Browser singleton — abrir um por chamada custa ~1.5s + 200MB RAM cada vez.
  // Chromium é thread-safe para Pages independentes, então um Browser serve
  // todas as gerações concorrentes do worker.
  private browser: Browser | null = null;
  private browserPromise: Promise<Browser> | null = null;

  async generate(input: TicketRenderInput): Promise<Buffer> {
    const browser = await this.getBrowser();
    const page = await browser.newPage();
    try {
      const html = this.buildHtml(input);
      await page.setContent(html, { waitUntil: 'networkidle0' });
      const pdf = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '20px', bottom: '20px', left: '20px', right: '20px' },
      });
      return Buffer.from(pdf);
    } finally {
      // Sempre fechar a Page (não o Browser) — Pages vazam memória se não.
      await page.close();
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Lazy-init com mutex via Promise. Múltiplas chamadas concorrentes durante
   * o boot esperam o mesmo launch — sem race que cria 2 browsers.
   */
  private async getBrowser(): Promise<Browser> {
    if (this.browser) return this.browser;
    if (this.browserPromise) return this.browserPromise;

    this.browserPromise = puppeteer.launch({
      headless: true,
      // --no-sandbox é necessário em containers Docker sem capabilities
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    this.browser = await this.browserPromise;
    this.browserPromise = null;
    this.logger.log('Chromium headless iniciado (singleton)');
    return this.browser;
  }

  private buildHtml(t: TicketRenderInput): string {
    const date = new Intl.DateTimeFormat('pt-BR', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    }).format(t.eventDate);

    // Atenção: o input já vem do consumer interno; ainda assim escapamos
    // o que é renderizado no HTML para evitar XSS no PDF.
    const esc = (s: string): string =>
      s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c));

    return `
      <!DOCTYPE html>
      <html lang="pt-BR"><head><meta charset="UTF-8"><style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Helvetica Neue', sans-serif; background: #f5f5f5; }
        .ticket { background: white; border-radius: 16px; overflow: hidden;
                  max-width: 600px; margin: 20px auto;
                  box-shadow: 0 4px 24px rgba(0,0,0,0.1); }
        .header { background: linear-gradient(135deg, #1a1a2e, #16213e);
                  color: white; padding: 32px; }
        .header h1 { font-size: 24px; font-weight: 700; margin-bottom: 8px; }
        .body { display: flex; padding: 32px; gap: 32px; align-items: center; }
        .info { flex: 1; }
        .label { font-size: 11px; text-transform: uppercase; letter-spacing: 1px;
                 color: #999; margin-bottom: 4px; }
        .value { font-size: 16px; font-weight: 600; color: #1a1a2e; margin-bottom: 20px; }
        .qr { text-align: center; }
        .qr img { width: 160px; height: 160px; }
        .code { font-family: monospace; font-size: 18px; font-weight: 700;
                color: #1a1a2e; margin-top: 8px; letter-spacing: 3px; }
        .footer { background: #f8f8f8; border-top: 1px dashed #e0e0e0;
                  padding: 16px 32px; font-size: 12px; color: #999;
                  display: flex; justify-content: space-between; }
      </style></head><body>
        <div class="ticket">
          <div class="header">
            <h1>${esc(t.eventTitle)}</h1>
            <div>ShowPass • Ingresso Oficial</div>
          </div>
          <div class="body">
            <div class="info">
              <div class="label">Data e Horário</div>
              <div class="value">${date}</div>
              <div class="label">Local</div>
              <div class="value">${esc(t.venueName)}</div>
              <div class="label">Tipo de Ingresso</div>
              <div class="value">${esc(t.batchName)}</div>
              ${t.seatLabel ? `
                <div class="label">Assento</div>
                <div class="value">${esc(t.seatLabel)}</div>` : ''}
              ${t.holderName ? `
                <div class="label">Portador</div>
                <div class="value">${esc(t.holderName)}</div>` : ''}
            </div>
            <div class="qr">
              <img src="${t.qrCodeDataUrl}" alt="QR Code">
              <div class="code">${esc(t.ticketCode)}</div>
            </div>
          </div>
          <div class="footer">
            <span>ID: ${esc(t.ticketId)}</span>
            <span>Apresente este ingresso na entrada</span>
          </div>
        </div>
      </body></html>
    `;
  }
}
```

---

## Passo 9.4 — `EmailService` (Resend)

Em produção real, considerar Amazon SES (sem rate limit duro do Resend free
tier). API é praticamente igual.

```typescript
// apps/worker-service/src/modules/email/email.service.ts

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
      dateStyle: 'full', timeStyle: 'short',
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
        filename: `ingresso-${i + 1}-${t.ticketCode}.pdf`,
        content: t.pdfBuffer,
      })),
    });

    this.logger.log(`E-mail enviado para ${params.to}`, {
      ticketCount: params.tickets.length,
    });
  }
}
```

---

## Passo 9.5 — `PaymentConfirmedConsumer` com DLQ real

Este é o coração do worker. Cinco responsabilidades:

1. Validar payload com `PaymentConfirmedEventSchema` (Zod)
2. **Idempotência** — se já existem tickets para `orderId`, pular
3. Carregar dados das réplicas locais (Buyer, Event, TicketBatch)
4. Para cada item × quantity, gerar Ticket + QR + PDF
5. Enviar e-mail; em caso de falha, registrar `FailedJob` e emit no `.dlt`

> **DLQ não é automática no NestJS Kafka.** Quem falha após retries vai
> precisar de tratamento explícito: capturar a exceção, decidir se retentar
> (relançar) ou desistir (logar + emitir para `.dlt` + commit do offset).
> Aqui implementamos o caminho desistir-com-rastro.

```typescript
// apps/worker-service/src/modules/tickets/payment-confirmed.consumer.ts

import { Controller, Logger } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { randomUUID } from 'node:crypto';

import {
  KAFKA_TOPICS,
  PaymentConfirmedEventSchema,
} from '@showpass/types';
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
      // Mensagem malformada: relançar não adianta (vai falhar de novo).
      // Direto pra DLT.
      await this.sendToDlt(raw, new Error('Schema validation failed'));
      return;
    }

    const event = parsed.data;

    // ─── 2. Idempotência ──────────────────────────────────────────────────
    // Kafka at-least-once: a mesma mensagem pode chegar 2x se houve crash
    // entre o processamento e o commit do offset. Ingressos já gerados =
    // não regerar (gerar 2x cria 2x QR Codes válidos = fraude).
    const already = await this.prisma.ticket.count({
      where: { orderId: event.orderId },
    });
    if (already > 0) {
      this.logger.log('Tickets já gerados — idempotente', {
        orderId: event.orderId, count: already,
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
    // rápido que a replicação (raro, mas possível em primeiro deploy),
    // re-throw força retry — Kafka reentrega após backoff curto.
    if (!buyer || !eventData) {
      const missing = [!buyer && 'buyer', !eventData && 'event'].filter(Boolean).join(', ');
      this.logger.warn(`Réplica local ausente (${missing}) — relançando para retry`, {
        orderId: event.orderId,
      });
      throw new Error(`Replicas not yet synchronized: ${missing}`);
    }

    const batchById = new Map(batches.map((b) => [b.id, b]));

    // ─── 4. Gerar tickets ─────────────────────────────────────────────────
    try {
      const generated: Array<{ ticketCode: string; pdfBuffer: Buffer }> = [];

      for (const item of event.items) {
        // 1 ticket por unidade — general admission com quantity=3 vira 3 tickets
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
            // event-service mantém Seat localmente, sem replicação ainda).
            // Quando seatId existe, mostramos o uuid abreviado como rótulo.
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
        // E-mail falhou MAS tickets já estão no banco — usuário pode reaver
        // no dashboard. Logar e seguir; reenvio de e-mail é tarefa separada
        // (job manual ou retry com tabela de outbox de e-mail).
        this.logger.error('Falha ao enviar e-mail (tickets emitidos OK)', {
          orderId: event.orderId, error: (err as Error).message,
        });
      }

      this.logger.log('Pipeline concluída', {
        orderId: event.orderId, ticketCount: generated.length,
      });

    } catch (err) {
      // ─── 6. Falha não-recuperável → DLT ────────────────────────────────
      // Falhas idempotentes (lock contention, deadlock Postgres) já teriam
      // sido cobertas por retry do Kafka antes de chegar aqui se relancarmos.
      // Esta versão simplificada: 1ª falha que chega no catch vai pra DLT
      // direto. Versão produção: contar attempts no Redis e só DLT após N.
      this.logger.error('Falha na pipeline — enviando para DLT', {
        orderId: event.orderId, error: (err as Error).message,
      });
      await this.sendToDlt(event, err as Error);
      // NÃO relançar: relançar deixaria a mensagem na partição original e
      // ficaríamos em loop. DLT é o destino final.
    }
  }

  /**
   * Envia para o tópico .dlt + persiste FailedJob para auditoria.
   * Os dois precisam acontecer juntos: tópico permite reprocessamento via
   * outro consumer (cap-17 alerting); a tabela permite filtrar por status.
   */
  private async sendToDlt(payload: unknown, err: Error): Promise<void> {
    try {
      await this.kafka.emit(
        DLT_TOPIC as never,                 // const assertion: KAFKA_TOPICS é mais restrito
        { original: payload, error: err.message, occurredAt: new Date().toISOString() },
        // Sem chave: DLT não tem afinidade de partição
      );
    } catch (emitErr) {
      this.logger.error('Falha ao emitir DLT — fallback só em FailedJob', emitErr);
    }

    await this.prisma.failedJob.create({
      data: {
        topic: KAFKA_TOPICS.PAYMENT_CONFIRMED,
        payload: payload as object, // Json type aceita qualquer objeto serializável
        errorMessage: err.message,
        status: 'pending_review',
      },
    });
  }
}
```

> **Sobre a tipagem do DLT:** `KAFKA_TOPICS` é `as const`, então
> `kafka.emit` aceita só os topics declarados. O `as never` força — em
> produção, prefira adicionar `PAYMENT_CONFIRMED_DLT` ao enum de tópicos
> para manter type-safety.

---

## Passo 9.6 — `PdfStorageService` (S3 em prod, fake em dev)

Manter o PDF em memória + e-mail é OK no curto prazo, mas o usuário precisa
poder baixar o ingresso depois. Storage é S3 (ou MinIO local) com URL
pré-assinada de 7 dias.

```typescript
// apps/worker-service/src/modules/tickets/pdf-storage.service.ts

import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class PdfStorageService {
  private readonly logger = new Logger(PdfStorageService.name);

  /**
   * Em dev: retorna URL fake (não armazenamos de fato — economia de espaço).
   * Em prod: upload para S3 com cliente @aws-sdk/client-s3 (cap-16).
   *
   * O contrato é estável: callers persistem só a URL no Ticket.pdfUrl.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- pdfBuffer usado em prod
  async upload(_pdfBuffer: Buffer, ticketId: string): Promise<string> {
    if (process.env['NODE_ENV'] !== 'production') {
      return `https://storage.showpass.local/tickets/${ticketId}.pdf`;
    }

    // TODO cap-16: PutObjectCommand + getSignedUrl com 7 dias de TTL
    return `https://storage.showpass.com.br/tickets/${ticketId}.pdf`;
  }
}
```

---

## Passo 9.7 — `DlqAuditConsumer` (opcional, para alerting)

Consumer que escuta o `.dlt` e gera evento de alerta (Slack/PagerDuty no
cap-17). Isolado em consumer próprio porque o tópico DLT pode ter regras
diferentes (group separado, low-throughput).

```typescript
// apps/worker-service/src/modules/dlq/dlq-audit.consumer.ts

import { Controller, Logger } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { KAFKA_TOPICS } from '@showpass/types';

@Controller()
export class DlqAuditConsumer {
  private readonly logger = new Logger(DlqAuditConsumer.name);

  @EventPattern(`${KAFKA_TOPICS.PAYMENT_CONFIRMED}.dlt`)
  async onDlt(@Payload() payload: unknown): Promise<void> {
    this.logger.error('DLT: payments.payment-confirmed.dlt', { payload });
    // cap-17: integração com Slack/PagerDuty
    // await this.alerting.send({ severity: 'high', payload, ... });
  }
}
```

---

## Passo 9.8 — `main.ts` (apenas Kafka, sem HTTP público)

O worker-service não expõe rotas HTTP (não precisa — só consome Kafka).
Pode opcionalmente expor `/health` para liveness probe do K8s.

```typescript
// apps/worker-service/src/main.ts

import 'dotenv/config';
import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { Transport } from '@nestjs/microservices';
import type { MicroserviceOptions } from '@nestjs/microservices';
import { AppModule } from './app.module.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.KAFKA,
    options: {
      client: {
        clientId: process.env['KAFKA_CLIENT_ID'] ?? 'worker-service',
        brokers: (process.env['KAFKA_BROKERS'] ?? 'localhost:29092').split(','),
      },
      consumer: {
        groupId:
          process.env['KAFKA_CONSUMER_GROUP_ID'] ?? 'worker-service-consumer',
        allowAutoTopicCreation: false,
      },
    },
  });

  await app.startAllMicroservices();

  // /health — só para liveness probe do K8s
  await app.listen(process.env['PORT'] ?? 3007);
}

void bootstrap();
```

---

## Passo 9.9 — `AppModule`, `.env`, Makefile

```typescript
// apps/worker-service/src/app.module.ts

import { Module } from '@nestjs/common';
import { KafkaModule } from '@showpass/kafka';

import { HealthModule } from './modules/health/health.module.js';
import { BuyersConsumer } from './modules/replicas/buyers.consumer.js';
import { EventsConsumer } from './modules/replicas/events.consumer.js';
import { TicketBatchesConsumer } from './modules/replicas/ticket-batches.consumer.js';
import { PaymentConfirmedConsumer } from './modules/tickets/payment-confirmed.consumer.js';
import { DlqAuditConsumer } from './modules/dlq/dlq-audit.consumer.js';
import { TicketGeneratorService } from './modules/tickets/ticket-generator.service.js';
import { PdfGeneratorService } from './modules/tickets/pdf-generator.service.js';
import { PdfStorageService } from './modules/tickets/pdf-storage.service.js';
import { EmailService } from './modules/email/email.service.js';
import { PrismaService } from './prisma/prisma.service.js';

@Module({
  imports: [
    KafkaModule.forRoot({
      clientId: process.env['KAFKA_CLIENT_ID'] ?? 'worker-service',
      brokers: (process.env['KAFKA_BROKERS'] ?? 'localhost:29092').split(','),
      groupId: process.env['KAFKA_GROUP_ID'] ?? 'worker-service-group',
    }),
    HealthModule,
  ],
  controllers: [
    BuyersConsumer,
    EventsConsumer,
    TicketBatchesConsumer,
    PaymentConfirmedConsumer,
    DlqAuditConsumer,
  ],
  providers: [
    PrismaService,
    TicketGeneratorService,
    PdfGeneratorService,
    PdfStorageService,
    EmailService,
  ],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- padrão NestJS
export class AppModule {}
```

```bash
# apps/worker-service/.env.example

NODE_ENV=development
PORT=3007
SERVICE_NAME=worker-service

DATABASE_URL="postgresql://worker_svc:worker_svc_dev@localhost:5432/showpass_worker"

# 64+ chars, gerar com: openssl rand -hex 32
TICKET_HMAC_SECRET=

# Resend (free tier funciona em dev — em prod, considerar SES)
RESEND_API_KEY=re_...

KAFKA_BROKERS=localhost:29092
KAFKA_CLIENT_ID=worker-service
KAFKA_GROUP_ID=worker-service-group
KAFKA_CONSUMER_GROUP_ID=worker-service-consumer
```

---

## Estratégia de scaling: vertical, não horizontal

> O Worker é o **único** serviço do projeto que escala vertical em vez de
> horizontalmente. Vale entender por quê.

```
api-gateway / booking-service / event-service:
  Stateless por request HTTP — qualquer pod atende qualquer cliente
  Escalar = adicionar pods (HPA por CPU)

worker-service:
  - Consumer Kafka tem afinidade de partição (N pods = no máx N partições úteis)
  - Puppeteer headless: ~200MB RAM por instância de Browser
  - Geração de PDF + QR é CPU-bound (não I/O bound)
  - Adicionar pods de 256MB RAM seria desperdício: o Browser nem sobe

Solução: 1 pod GRANDE > muitos pods pequenos
  requests:  memory: 1Gi   cpu: 500m
  limits:    memory: 4Gi   cpu: 2000m
  + aumentar partições do tópico se vier pico real
```

```yaml
# infra/k8s/base/worker-service/deployment.yaml (exemplo — cap-16)
resources:
  requests: { memory: "1Gi",  cpu: "500m"  }
  limits:   { memory: "4Gi",  cpu: "2000m" }
```

---

## Testando na prática

### O que precisa estar rodando

```bash
# Terminal 1 — infra
docker compose up -d

# Migrations + seed do worker
pnpm --filter @showpass/worker-service run db:generate
pnpm --filter @showpass/worker-service run db:migrate

# Terminal 2 — todos os serviços (gateway, auth, event, booking, payment, search, worker)
make dev-services

# Terminal 3 — Stripe CLI
stripe listen --forward-to http://localhost:3002/webhooks/stripe
```

### Passo a passo

**1. Disparar o fluxo completo (cap-07 passos 1–3) até o pagamento**

Ao concluir o pagamento no Stripe Checkout, o payment-service emite
`payments.payment-confirmed` no Kafka. O worker pega.

**2. Observar o worker processar**

```
[PaymentConfirmedConsumer] ... orderId: 018eb...
[PdfGeneratorService] Chromium headless iniciado (singleton)
[PaymentConfirmedConsumer] Pipeline concluída — ticketCount: 1
[EmailService] E-mail enviado para diego@email.com
```

**3. Verificar tickets no banco**

```bash
docker compose exec postgres psql -U showpass -d showpass_worker \
  -c "SELECT id, ticket_code, used_at FROM tickets WHERE order_id = '018eb...';"
```

**4. Idempotência — reentregar o mesmo evento**

```bash
# Pegar o evt_... do `stripe listen` e reenviar
stripe events resend evt_...
```

Log do worker: `Tickets já gerados — idempotente`. Nenhum ticket novo no banco.

**5. Validar QR Code (simulando check-in)**

```bash
# Pegar o qrCodePayload de um ticket
QR=$(docker compose exec -T postgres psql -U showpass -d showpass_worker \
  -t -c "SELECT qr_code_payload FROM tickets LIMIT 1;" | tr -d ' ')

# Sem endpoint HTTP no cap-9 — abrir um node REPL com o service injetado,
# ou criar um endpoint POST /tickets/validate como exercício.
```

**6. Testar a DLT — forçar uma falha**

Quebre temporariamente a `RESEND_API_KEY` (`RESEND_API_KEY=invalid` no `.env`)
e dispare um pagamento.

E-mail falha **mas tickets foram emitidos** (catch interno):
log `Falha ao enviar e-mail (tickets emitidos OK)`.

Para forçar a DLT, quebre algo "antes" da geração: `TICKET_HMAC_SECRET=`
(vazio) faz o `TicketGeneratorService` falhar no boot — o consumer cai inteiro.
Para um teste mais cirúrgico, force o `pdfGen.generate` a lançar e observe
no `failed_jobs`:

```bash
docker compose exec postgres psql -U showpass -d showpass_worker \
  -c "SELECT id, topic, status, error_message FROM failed_jobs ORDER BY failed_at DESC LIMIT 1;"
```

E inspecionar o tópico `.dlt`:

```bash
docker compose exec kafka /opt/kafka/bin/kafka-console-consumer.sh \
  --bootstrap-server localhost:9092 \
  --topic payments.payment-confirmed.dlt \
  --from-beginning --max-messages 1
```

---

## Pegadinhas comuns

| Sintoma | Causa | Correção |
|---|---|---|
| `Replicas not yet synchronized` em loop | Consumer do worker subiu antes do `auth.buyer-created`/`event.event-published` chegar | Aguardar; ou rodar backfill (cap-08 Passo "Backfill"). É só timing inicial. |
| Tickets em duplicata para o mesmo order | Idempotência ignorada / `ticket.count` não cobriu | Conferir índice `[orderId]` em `tickets`; nunca remover o `if (already > 0)` |
| PDF demora 3s+ por ticket | Browser sendo lançado por chamada (não singleton) | `getBrowser()` deve ser lazy-init com mutex; conferir log "Chromium iniciado" só uma vez |
| `TICKET_HMAC_SECRET ausente` no boot | `.env` não preenchido | `openssl rand -hex 32` e colar |
| `failed_jobs` enche rápido | Algum bug determinístico está enviando tudo pra DLT | NÃO é normal — investigar; DLT é exceção, não regra |
| Em prod, vários workers e mensagem é processada 2x | Consumer group errado | Mesma `KAFKA_CONSUMER_GROUP_ID` em todos os pods do worker |

---

## Recapitulando

1. **Processamento assíncrono** — webhook responde 200 em <100ms; pipeline
   pesada roda em outro processo
2. **Schema correto antes de tudo** — `PaymentConfirmedEventSchema` com
   `eventId` e `quantity` (sem isso, Zod `.strip()` silencioso quebra tudo)
3. **Réplicas locais via Kafka** — `Buyer`/`Event`/`TicketBatch` consumidos
   nos mesmos tópicos do booking/payment, sem novo HTTP cross-service
4. **QR Code HMAC-SHA256** — payload assinado; truncado a 16 chars hex
   (suficiente contra brute force online)
5. **Puppeteer Browser singleton** — 1 launch no boot, N Pages por chamada
   (lazy-init com mutex)
6. **DLQ explícita** — `try/catch` + emit para `.dlt` + `FailedJob` no
   banco. Não é automática — quem não codar isso, não tem
7. **Idempotência via `count > 0`** — at-least-once do Kafka cobre
   reentrega; checagem antes de gerar é a defesa mais simples
8. **Scaling vertical** — 1 pod com 4Gi RAM > vários pods de 256Mi (Puppeteer
   come RAM e não há benefício horizontal acima do número de partições)

---

## Próximo capítulo

[Capítulo 10 → Frontend Foundation](cap-10-frontend-foundation.md)
