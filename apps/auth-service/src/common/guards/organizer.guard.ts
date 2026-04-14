// apps/auth-service/src/common/guards/organizer.guard.ts
//
// Protege endpoints que só podem ser acessados por organizers.
// Extrai x-user-id e x-organizer-id das headers (injetados pelo Gateway).
// NÃO valida JWT — isso já foi feito no Gateway.
//
// Por que ler dos headers em vez de revalidar o JWT?
//   Evita duplicação de lógica de validação.
//   O Gateway já validou o token RS256 — confiar nos headers internos é seguro
//   dentro da rede privada do K8s (serviços não são expostos publicamente).

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import type { Request } from 'express';

@Injectable()
export class OrganizerGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();

    const userId = request.headers['x-user-id'];
    const userType = request.headers['x-user-type'];
    const organizerId = request.headers['x-organizer-id'];

    if (!userId) {
      throw new UnauthorizedException('Não autenticado');
    }

    if (userType !== 'organizer') {
      throw new ForbiddenException('Acesso exclusivo para organizadores');
    }

    if (!organizerId) {
      throw new ForbiddenException('Organizador não associado ao usuário');
    }

    return true;
  }
}
