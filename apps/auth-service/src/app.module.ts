// apps/auth-service/src/app.module.ts
//
// Módulo raiz do Auth Service.
// Rate limiting configurado em duas camadas:
//   - "default": 100 req/min para todos os endpoints
//   - "auth": 5 req/min para endpoints de login (OWASP A07)

import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from './modules/auth/auth.module.js';

@Module({
  imports: [
    // Rate limiting por IP — proteção contra brute force (OWASP A07)
    ThrottlerModule.forRoot([
      {
        name: 'default',
        ttl: 60_000,   // janela de 1 minuto
        limit: 100,    // máximo de requisições na janela
      },
      {
        name: 'auth',
        ttl: 60_000,
        limit: 5,      // login: máximo 5 tentativas/min
      },
    ]),
    AuthModule,
  ],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- padrão NestJS
export class AppModule {}
