// apps/api-gateway/src/common/middleware/jwt-auth.middleware.ts
//
// Valida o JWT e injeta os claims nas headers para os serviços downstream.
// Os serviços internos confiam no x-user-id e x-organizer-id sem revalidar —
// a validação acontece UMA VEZ aqui no gateway.

import {
  Injectable,
  NestMiddleware,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

// Formato dos claims do JWT do ShowPass
interface ShowPassJwtPayload {
  sub: string;          // user ID
  email: string;
  type: 'organizer' | 'buyer';
  organizerId?: string; // apenas para organizers
  iat: number;
  exp: number;
}

@Injectable()
export class JwtAuthMiddleware implements NestMiddleware {
  private readonly logger = new Logger(JwtAuthMiddleware.name);

  // Chave pública RSA para verificar assinaturas (RS256)
  // Apenas o auth-service tem a chave privada — gateway só verifica
  private readonly publicKey: string;

  constructor() {
    // Falhar na inicialização se a chave não estiver configurada
    // (melhor que falhar em runtime na primeira request autenticada)
    const key = process.env['JWT_PUBLIC_KEY'];
    if (!key) {
      throw new Error('JWT_PUBLIC_KEY não configurada — o API Gateway não pode iniciar sem ela');
    }
    // Variável de ambiente armazena \n como string literal — converter para quebra de linha real
    this.publicKey = key.replace(/\\n/g, '\n');
  }

  use(req: Request, _res: Response, next: NextFunction): void {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Token não fornecido');
    }

    const token = authHeader.substring(7);

    try {
      const payload = jwt.verify(token, this.publicKey, {
        algorithms: ['RS256'],
        // Validar audience para prevenir token de outro serviço ser aceito (confused deputy attack)
        audience: 'showpass-api',
        issuer: 'showpass-auth',
      }) as ShowPassJwtPayload;

      // Injetar claims nas headers para os serviços downstream
      // Os serviços NÃO precisam verificar o JWT de novo — confiam no gateway
      req.headers['x-user-id'] = payload.sub;
      req.headers['x-user-email'] = payload.email;
      req.headers['x-user-type'] = payload.type;

      if (payload.organizerId) {
        req.headers['x-organizer-id'] = payload.organizerId;
      }

      next();
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));

      // OWASP A09: logar falhas de auth sem expor detalhes ao cliente
      this.logger.warn('JWT inválido', {
        error: err.message,
        ip: req.ip,
        path: req.path,
      });

      // OWASP A07: mensagem genérica — não dizer "token expirado" vs "token inválido"
      // (evita oracle de autenticação)
      throw new UnauthorizedException('Token inválido ou expirado');
    }
  }
}
