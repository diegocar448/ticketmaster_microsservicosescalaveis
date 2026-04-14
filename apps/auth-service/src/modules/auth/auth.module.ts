// apps/auth-service/src/modules/auth/auth.module.ts
//
// Módulo de autenticação — agrega serviços, guards e estratégias JWT.
//
// Configuração JwtModule:
//   - Algoritmo RS256 assimétrico (chave privada para assinar, pública para verificar)
//   - Chave privada carregada do sistema de arquivos na inicialização
//   - Audience e issuer para prevenir token confusion attacks

import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AuthController } from './auth.controller.js';
import { OrganizerAuthService } from './organizer-auth.service.js';
import { BuyerAuthService } from './buyer-auth.service.js';
import { TokenService } from './token.service.js';
import { JwtStrategy } from './strategies/jwt.strategy.js';
import { PrismaService } from '../../prisma/prisma.service.js';

// Chave privada carregada uma vez na inicialização do módulo
// Se o arquivo não existir → NestJS falha ao iniciar (desejável — fail fast)
// __dirname disponível em CJS (NodeNext sem "type":"module" no package.json)
// eslint-disable-next-line security/detect-non-literal-fs-filename -- caminho calculado em tempo de inicialização, não vem de input do usuário
const privateKey = readFileSync(join(__dirname, '../../../keys/private.pem'));

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
