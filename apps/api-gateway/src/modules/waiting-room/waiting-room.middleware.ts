// Intercepta requisições de compra de ingressos em eventos de alta demanda.
// Se o evento está em modo de fila → verificar se o usuário tem admission token.

import { Injectable, NestMiddleware } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { WaitingRoomService } from './waiting-room.service';

@Injectable()
export class WaitingRoomMiddleware implements NestMiddleware {
  constructor(private readonly waitingRoom: WaitingRoomService) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    // Apenas para rotas de reserva
    if (!req.path.includes('/bookings/reservations')) {
      next();
      return;
    }

    // req.body é `any` do Express — extrair eventId de forma segura
    const rawBody = req.body as Record<string, unknown> | undefined;
    const eventId = typeof rawBody?.['eventId'] === 'string' ? rawBody['eventId'] : undefined;
    if (!eventId) {
      next();
      return;
    }

    // Verificar se está em alta demanda
    const highDemand = await this.waitingRoom.isHighDemand(eventId);
    if (!highDemand) {
      next();
      return;
    }

    // Verificar admission token (header personalizado)
    const admissionToken = req.headers['x-admission-token'] as string | undefined;

    if (!admissionToken) {
      // Sem token → mandar para a fila de espera
      const queue = await this.waitingRoom.joinQueue(eventId);

      res.status(202).json({
        message: 'Evento em alta demanda. Você entrou na fila de espera.',
        waitingRoom: {
          token: queue.token,
          position: queue.position,
          estimatedWaitSeconds: queue.estimatedWaitSeconds,
          pollingUrl: `/waiting-room/${eventId}/position?token=${queue.token}`,
        },
      });
      return;
    }

    // Com token → validar e continuar
    next();
  }
}