// apps/api-gateway/src/modules/proxy/proxy.controller.ts
//
// Roteia requests para os microserviços internos.
// O gateway é stateless — apenas valida, enriquece headers, e repassa.

import { All, Controller, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';

// Mapa de rotas: prefixo → URL do serviço interno
// Em produção, as URLs vêm de variáveis de ambiente (service discovery via DNS interno do K8s)
const SERVICE_MAP: Record<string, string> = {
  '/auth':        process.env['AUTH_SERVICE_URL']    ?? 'http://localhost:3006',
  '/events':      process.env['EVENT_SERVICE_URL']   ?? 'http://localhost:3003',
  '/venues':      process.env['EVENT_SERVICE_URL']   ?? 'http://localhost:3003',
  '/categories':  process.env['EVENT_SERVICE_URL']   ?? 'http://localhost:3003',
  '/organizers':  process.env['EVENT_SERVICE_URL']   ?? 'http://localhost:3003',
  '/bookings':    process.env['BOOKING_SERVICE_URL'] ?? 'http://localhost:3004',
  '/payments':    process.env['PAYMENT_SERVICE_URL'] ?? 'http://localhost:3002',
  '/search':      process.env['SEARCH_SERVICE_URL']  ?? 'http://localhost:3005',
  '/tickets':     process.env['WORKER_SERVICE_URL']  ?? 'http://localhost:3007',
  '/webhooks':    process.env['PAYMENT_SERVICE_URL'] ?? 'http://localhost:3002',
};

@Controller()
export class ProxyController {
  /**
   * Captura todas as rotas e repassa ao serviço correto.
   * O proxy é criado sob demanda baseado no path da request.
   */
  @All('*')
  proxy(@Req() req: Request, @Res() res: Response): void {
    const targetService = this.resolveTarget(req.path);

    if (!targetService) {
      res.status(404).json({
        statusCode: 404,
        message: `Rota não encontrada: ${req.path}`,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const proxy = createProxyMiddleware({
      target: targetService,
      changeOrigin: true,
      // Repassar os headers de auth injetados pelo JwtAuthMiddleware
      headers: {
        'x-forwarded-for': req.ip ?? '',
        'x-real-ip': req.ip ?? '',
      },
      on: {
        error: (_err, _req, proxyRes) => {
          // Resposta segura ao cliente quando o serviço downstream está indisponível
          (proxyRes as Response).status(503).json({
            statusCode: 503,
            message: 'Serviço temporariamente indisponível',
            timestamp: new Date().toISOString(),
          });
        },
      },
    });

    // void: http-proxy-middleware resolve internamente — next() nunca é chamado
    void proxy(req, res, () => undefined);
  }

  private resolveTarget(path: string): string | null {
    for (const [prefix, url] of Object.entries(SERVICE_MAP)) {
      if (path.startsWith(prefix)) {
        return url;
      }
    }
    return null;
  }
}
