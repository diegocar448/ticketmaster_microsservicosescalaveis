// apps/booking-service/src/modules/reservations/commands/create-reservation.command.ts
//
// CQRS: Commands representam INTENÇÕES de mudar estado.
//
// Por que CQRS separa Commands de Queries?
// - Escalar leituras e escritas independentemente:
//   Commands → primary DB (writes); Queries → read replica (reads)
// - Rastrear todas as intenções: auditoria completa de "quem pediu o quê"
// - Isolar efeitos colaterais: handlers testáveis sem precisar do controller
//
// Um Command não retorna dados de domínio — apenas dispara a ação.
// O retorno (se existir) é o mínimo necessário para o caller (ex: ID gerado).

import type { ICommand } from '@nestjs/cqrs';
import type { CreateReservationDto } from '@showpass/types';

export class CreateReservationCommand implements ICommand {
  constructor(
    public readonly buyerId: string,
    public readonly dto: CreateReservationDto,
  ) {}
}
