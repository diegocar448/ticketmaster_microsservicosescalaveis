// apps/auth-service/src/modules/auth/strategies/jwt.strategy.ts
//
// Configura o passport-jwt para verificar tokens RS256.
// Esta estratégia é usada no próprio auth-service para
// endpoints protegidos (ex: logout, refresh).
//
// Por que RS256?
//   Chave privada só existe no auth-service → outros serviços não podem forjar tokens.
//   Ver CLAUDE.md do auth-service para invariantes de segurança.

import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface JwtPayload {
  sub: string;           // user ID
  email: string;
  type: 'organizer' | 'buyer';
  organizerId?: string;
  iat: number;
  exp: number;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor() {
    // Tentar carregar chave pública — se não existir, lançar erro na inicialização
    // (melhor falhar cedo do que aceitar tokens sem verificação)
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- caminho calculado em tempo de inicialização, não vem de input do usuário
    const publicKey = readFileSync(join(__dirname, '../../../../keys/public.pem'));

    super({
      // Extrair token do header Authorization: Bearer <token>
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      // Chave pública para verificar assinatura RS256
      secretOrKey: publicKey,
      algorithms: ['RS256'],
      audience: 'showpass-api',
      issuer: 'showpass-auth',
    });
  }

  validate(payload: JwtPayload): JwtPayload {
    // O que retornar aqui é injetado em req.user
    return payload;
  }
}
