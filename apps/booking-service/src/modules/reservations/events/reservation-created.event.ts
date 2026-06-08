// apps/booking-service/src/modules/reservations/events/reservation-created.event.ts
//
// Domain Event (NestJS CQRS EventBus) — diferente do evento Kafka.
//
// O EventBus local (in-process) notifica handlers síncronos no mesmo serviço.
// O evento Kafka (externo) notifica outros serviços de forma assíncrona.
//
// Separação deliberada:
//   - EventBus local: handlers que devem executar na mesma transação
//   - Kafka: serviços externos que reagem de forma eventually consistent
//
// Este evento é publicado pelo CreateReservationHandler após persistir no banco.
// O ReservationCreatedEventHandler (futuro) pode, por exemplo, enfileirar
// notificações ou atualizar read models locais.

import type { IEvent } from '@nestjs/cqrs';

export class ReservationCreatedEvent implements IEvent {
  constructor(
    public readonly reservationId: string,
    public readonly buyerId: string,
    public readonly eventId: string,
  ) {}
}
