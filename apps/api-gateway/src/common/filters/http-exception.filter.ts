// apps/api-gateway/src/common/filters/http-exception.filter.ts
//
// Formata TODOS os erros HTTP de forma segura:
// - Em produção: sem stack trace, sem detalhes internos
// - Em desenvolvimento: mensagem de debug exposta
// OWASP A05: não vazar informações de implementação ao cliente

import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let statusCode: number;
    let message: string | string[];

    if (exception instanceof HttpException) {
      statusCode = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      message =
        typeof exceptionResponse === 'object' && 'message' in exceptionResponse
          ? (exceptionResponse as { message: string | string[] }).message
          : exception.message;
    } else {
      statusCode = HttpStatus.INTERNAL_SERVER_ERROR;

      // OWASP A05: nunca expor erro interno em produção
      message =
        process.env['NODE_ENV'] === 'production'
          ? 'Erro interno do servidor'
          : exception instanceof Error
            ? exception.message
            : String(exception);
    }

    // OWASP A09: logar TODOS os erros 5xx com contexto completo (nunca expor ao cliente)
    if (statusCode >= 500) {
      this.logger.error('Erro interno', {
        statusCode,
        path: request.path,
        method: request.method,
        requestId: request.headers['x-request-id'],
        error: exception instanceof Error ? exception.stack : String(exception),
      });
    }

    response.status(statusCode).json({
      statusCode,
      message,
      timestamp: new Date().toISOString(),
      requestId: request.headers['x-request-id'] as string | undefined,
      path: request.path,
    });
  }
}
