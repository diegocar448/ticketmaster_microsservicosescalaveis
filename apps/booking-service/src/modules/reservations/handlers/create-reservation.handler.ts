// apps/booking-service/src/modules/reservations/handlers/create-reservation.handler.ts
//
// Command Handler: executa CreateReservationCommand.
//
// Por que delegar para ReservationsService em vez de conter a lógica aqui?
// Migração incremental: CQRS é adicionado sobre a camada de serviço existente.
// Handlers podem conter a lógica diretamente (Event Sourcing avançado) ou
// delegar para serviços de domínio. Para o tutorial, delegação é mais claro.
//
// Em produção com Event Sourcing full:
//   handler → aplica eventos ao aggregate → persiste snapshot → emite domain events

import { CommandHandler, EventBus, type ICommandHandler } from '@nestjs/cqrs';
import type { Prisma } from '../../../prisma/generated/index.js';
import { CreateReservationCommand } from '../commands/create-reservation.command.js';
import { ReservationCreatedEvent } from '../events/reservation-created.event.js';
import { ReservationsService } from '../reservations.service.js';

type ReservationWithItems = Prisma.ReservationGetPayload<{
  include: { items: true };
}>;

@CommandHandler(CreateReservationCommand)
export class CreateReservationHandler
  implements ICommandHandler<CreateReservationCommand, ReservationWithItems>
{
  constructor(
    private readonly reservationsService: ReservationsService,
    // EventBus do CQRS (in-process) — não confundir com Kafka
    private readonly eventBus: EventBus,
  ) {}

  async execute(command: CreateReservationCommand): Promise<ReservationWithItems> {
    const { buyerId, dto } = command;

    // Toda a lógica de lock + banco + kafka permanece no ReservationsService.
    // O handler adiciona a camada CQRS sem duplicar regras de negócio.
    const reservation = await this.reservationsService.create(buyerId, dto);

    // Publicar domain event local — handlers síncronos (ex: audit log) reagem aqui.
    // O evento Kafka já foi emitido dentro do ReservationsService.create().
    await this.eventBus.publish(
      new ReservationCreatedEvent(reservation.id, buyerId, dto.eventId),
    );

    return reservation;
  }
}
