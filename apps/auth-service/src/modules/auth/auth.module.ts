// apps/auth-service/src/modules/auth/auth.module.ts
//
// Módulo de autenticação — agrega serviços, guards e estratégias JWT.
//
// Configuração JwtModule:
//   - Algoritmo RS256 assimétrico (chave privada para assinar, pública para verificar)
//   - Chave privada lida de JWT_PRIVATE_KEY no .env (12-factor: config via env)
//   - Audience e issuer para prevenir token confusion attacks

import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller.js';
import { OrganizerAuthService } from './organizer-auth.service.js';
import { BuyerAuthService } from './buyer-auth.service.js';
import { TokenService } from './token.service.js';
import { JwtStrategy } from './strategies/jwt.strategy.js';
import { PrismaService } from '../../prisma/prisma.service.js';

// Fail fast: se JWT_PRIVATE_KEY não estiver definida, o serviço não sobe.
// dotenv carrega o .env antes deste módulo ser avaliado (ver main.ts).
const privateKey = process.env['JWT_PRIVATE_KEY'];
if (!privateKey) {
  throw new Error('JWT_PRIVATE_KEY não definida — rode make gen-keys e verifique o .env');
}

@Module({
  imports: [
    PassportModule,
    JwtModule.register({
      privateKey,
      signOptions: {
        algorithm: 'RS256',
        audience: 'showpass-api',
        issuer: 'showpass-auth',
        expiresIn: '15m',
      },
    }),
  ],
  controllers: [AuthController],
  providers: [
    PrismaService,
    TokenService,
    OrganizerAuthService,
    BuyerAuthService,
    JwtStrategy,
  ],
  exports: [TokenService, PrismaService],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- padrão NestJS
export class AuthModule {}
