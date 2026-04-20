// apps/booking-service/src/common/guards/buyer.guard.ts
//
// Protege endpoints exclusivos de compradores.
// Headers são injetados pelo Gateway após validação do JWT.

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import type { Request } from 'express';

@Injectable()
export class BuyerGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();

    const userId = request.headers['x-user-id'];
    const userType = request.headers['x-user-type'];

    if (!userId) {
      throw new UnauthorizedException('Não autenticado');
    }

    if (userType !== 'buyer') {
      throw new ForbiddenException('Acesso exclusivo para compradores');
    }

    return true;
  }
}
