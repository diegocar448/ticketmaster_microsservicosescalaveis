// apps/booking-service/src/modules/reservations/queries/get-buyer-reservations.query.ts
//
// CQRS Query: apenas lê dados, nunca muda estado.
//
// Separar reads de writes permite:
// 1. Rotear queries para a read replica do Postgres (escala horizontal de leituras)
// 2. Adicionar cache sem contaminar a lógica de escrita
// 3. Retornar projeções customizadas sem afetar o aggregate de escrita
//
// Em produção com alta carga: substituir Prisma aqui por query raw + índice
// cobrindo (buyerId, createdAt DESC) — sem impactar o fluxo de criação.

import { QueryHandler, type IQueryHandler } from '@nestjs/cqrs';
import type { Prisma } from '../../../prisma/generated/index.js';
import { PrismaService } from '../../../prisma/prisma.service.js';

type ReservationWithItems = Prisma.ReservationGetPayload<{
  include: { items: true };
}>;

export class GetBuyerReservationsQuery {
  constructor(
    public readonly buyerId: string,
    // Filtro opcional: pending, confirmed, cancelled, expired
    public readonly status?: string,
  ) {}
}

@QueryHandler(GetBuyerReservationsQuery)
export class GetBuyerReservationsHandler
  implements IQueryHandler<GetBuyerReservationsQuery, ReservationWithItems[]>
{
  constructor(private readonly prisma: PrismaService) {}

  async execute(query: GetBuyerReservationsQuery): Promise<ReservationWithItems[]> {
    return this.prisma.reservation.findMany({
      where: {
        buyerId: query.buyerId,
        // Filtro de status omitido quando undefined — retorna todos os status
        ...(query.status ? { status: query.status } : {}),
      },
      include: { items: true },
      orderBy: { createdAt: 'desc' },
    });
  }
}
