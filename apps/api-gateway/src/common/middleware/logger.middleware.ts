// apps/api-gateway/src/common/middleware/logger.middleware.ts
//
// Loga cada request com contexto suficiente para debug em produção.
// Em produção, esses logs vão para o Loki via OpenTelemetry.

import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';

@Injectable()
export class LoggerMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HTTP');

  use(req: Request, res: Response, next: NextFunction): void {
    const { method, originalUrl, ip } = req;
    const requestId = req.headers['x-request-id'] as string | undefined;
    const startTime = Date.now();

    res.on('finish', () => {
      const { statusCode } = res;
      const duration = Date.now() - startTime;

      // OWASP A09: logar sem dados sensíveis (sem corpo da request, sem Authorization header)
      this.logger.log(`${method} ${originalUrl} ${statusCode.toString()} ${duration.toString()}ms`, {
        method,
        path: originalUrl,
        statusCode,
        duration,
        ip,
        requestId,
        // User info se disponível (injetado pelo JwtAuthMiddleware)
        userId: req.headers['x-user-id'] as string | undefined,
      });
    });

    next();
  }
}
