// apps/api-gateway/src/app.module.ts
// Módulo raiz: rate limiting, middlewares e roteamento para microserviços.

import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { ProxyModule } from './modules/proxy/proxy.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { JwtAuthMiddleware } from './common/middleware/jwt-auth.middleware.js';
import { LoggerMiddleware } from './common/middleware/logger.middleware.js';

@Module({
  imports: [
    // ─── Rate Limiting (OWASP A07) ────────────────────────────────────────────
    ThrottlerModule.forRoot([
      {
        // Tier 1: limite global por IP
        name: 'global',
        ttl: 60_000,   // janela de 60 segundos
        limit: 300,    // 300 req/min por IP
      },
      {
        // Tier 2: limite mais restrito para endpoints de auth
        name: 'auth',
        ttl: 60_000,
        limit: 5,      // 5 tentativas de login/min — previne brute force (OWASP A07)
      },
    ]),

    ProxyModule,
    HealthModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      // Logar todas as requests (ordem importa: logger antes do auth)
      .apply(LoggerMiddleware)
      .forRoutes('*')
      // Auth em todas as rotas exceto as públicas
      .apply(JwtAuthMiddleware)
      .exclude(
        'health',
        'health/(.*)',
        'docs',
        'docs/(.*)',
        // Rotas de auth emitem o token — não precisam dele para entrar
        { path: 'auth/login', method: RequestMethod.POST },
        { path: 'auth/register', method: RequestMethod.POST },
        { path: 'auth/refresh', method: RequestMethod.POST },
        { path: 'auth/buyer/login', method: RequestMethod.POST },
        { path: 'auth/buyer/register', method: RequestMethod.POST },
        // Busca de eventos é pública
        { path: 'events', method: RequestMethod.GET },
        { path: 'events/(.*)', method: RequestMethod.GET },
        { path: 'search/(.*)', method: RequestMethod.GET },
        // Webhook do Stripe — autenticado via HMAC, não JWT
        { path: 'webhooks/stripe', method: RequestMethod.POST },
      )
      .forRoutes('*');
  }
}
