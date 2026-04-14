// apps/api-gateway/src/common/interceptors/request-id.interceptor.ts
//
// Injeta um ID único em cada request — rastreamento distribuído.
// O mesmo ID é repassado a todos os serviços downstream via header.
// No Grafana/Loki você busca por este ID e vê o fluxo completo.

import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';

@Injectable()
export class RequestIdInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();

    // Usar o ID enviado pelo cliente (Cloudflare, load balancer) ou gerar novo
    const requestId =
      (request.headers['x-request-id'] as string | undefined) ??
      (request.headers['cf-ray'] as string | undefined) ?? // Cloudflare Ray ID
      randomUUID();

    // Injetar na request (para filtros e outros middlewares usarem)
    request.headers['x-request-id'] = requestId;

    // Retornar o ID na response para o cliente correlacionar com seus logs
    response.setHeader('x-request-id', requestId);

    const start = Date.now();

    return next.handle().pipe(
      tap(() => {
        // Alertar sobre requests lentas (> 1s) — threshold para SLO de latência
        response.on('finish', () => {
          const duration = Date.now() - start;
          if (duration > 1000) {
            console.warn(
              `[SLOW REQUEST] ${request.method} ${request.path} - ${duration.toString()}ms | requestId=${requestId}`,
            );
          }
        });
      }),
    );
  }
}
