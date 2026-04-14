// packages/types/src/decorators/current-user.decorator.ts
//
// Extrai o usuário autenticado do contexto da request.
// Elimina o boilerplate de acessar headers manualmente em cada controller.
//
// Uso:
//   @Get('profile')
//   @UseGuards(OrganizerGuard)
//   getProfile(@CurrentUser() user: AuthenticatedUser) { ... }
//
// Os headers x-user-* são injetados pelo Gateway após validação JWT RS256.

import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

export interface AuthenticatedUser {
  id: string;
  email: string;
  type: 'organizer' | 'buyer';
  organizerId?: string;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const request = ctx.switchToHttp().getRequest<Request>();

    // exactOptionalPropertyTypes: omitir organizerId se ausente em vez de passar undefined
    const organizerId = request.headers['x-organizer-id'] as string | undefined;
    const user: AuthenticatedUser = {
      id: request.headers['x-user-id'] as string,
      email: request.headers['x-user-email'] as string,
      type: request.headers['x-user-type'] as 'organizer' | 'buyer',
    };

    if (organizerId) {
      user.organizerId = organizerId;
    }

    return user;
  },
);
