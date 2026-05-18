// apps/worker-service/src/modules/tickets/pdf-generator.service.ts
//
// Puppeteer com Browser singleton: abrir 1 Browser por chamada custa ~1.5s +
// ~200MB RAM. Mantemos um Browser vivo e criamos só Pages sob demanda.

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
   * Lazy-init com mutex via Promise. Chamadas concorrentes no boot esperam o
   * mesmo launch — sem race que cria 2 browsers.
   */
  private async getBrowser(): Promise<Browser> {
    if (this.browser) return this.browser;
    if (this.browserPromise) return this.browserPromise;

    this.browserPromise = puppeteer.launch({
      headless: true,
      // --no-sandbox necessário em containers Docker sem capabilities
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    this.browser = await this.browserPromise;
    this.browserPromise = null;
    this.logger.log('Chromium headless iniciado (singleton)');
    return this.browser;
  }

  private buildHtml(t: TicketRenderInput): string {
    const date = new Intl.DateTimeFormat('pt-BR', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(t.eventDate);

    // O input vem do consumer interno; ainda assim escapamos o que é
    // renderizado no HTML para evitar XSS no PDF.
    const esc = (s: string): string =>
      s.replace(
        /[&<>"']/g,
        (c) =>
          ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;',
          })[c] ?? c,
      );

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
              ${
                t.seatLabel
                  ? `
                <div class="label">Assento</div>
                <div class="value">${esc(t.seatLabel)}</div>`
                  : ''
              }
              ${
                t.holderName
                  ? `
                <div class="label">Portador</div>
                <div class="value">${esc(t.holderName)}</div>`
                  : ''
              }
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
