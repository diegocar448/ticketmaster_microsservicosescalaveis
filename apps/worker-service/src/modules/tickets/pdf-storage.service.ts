// apps/worker-service/src/modules/tickets/pdf-storage.service.ts
//
// Em dev: URL fake (não armazena de fato). Em prod: S3 (@aws-sdk/client-s3,
// cap-16). Contrato estável — callers persistem só a URL em Ticket.pdfUrl.
// Retorno Promise<string> sem `async` (a versão dev é síncrona; a versão S3
// será de fato assíncrona sem mudar o contrato — evita require-await).

import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class PdfStorageService {
  private readonly logger = new Logger(PdfStorageService.name);

  upload(_pdfBuffer: Buffer, ticketId: string): Promise<string> {
    if (process.env['NODE_ENV'] !== 'production') {
      this.logger.debug(`PDF (dev, não persistido): ${ticketId}`);
      return Promise.resolve(
        `https://storage.showpass.local/tickets/${ticketId}.pdf`,
      );
    }

    // TODO cap-16: PutObjectCommand + getSignedUrl com 7 dias de TTL
    return Promise.resolve(
      `https://storage.showpass.com.br/tickets/${ticketId}.pdf`,
    );
  }
}
