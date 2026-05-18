import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ReservationsService } from './reservations.service.js';
import { SeatLockService } from '../locks/seat-lock.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { BuyerGuard } from '../../common/guards/buyer.guard.js';
import { CurrentUser, type AuthenticatedUser } from '@showpass/types';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { CreateReservationSchema, type CreateReservationDto } from '@showpass/types';

@Controller('bookings/reservations')
export class ReservationsController {
  constructor(
    private readonly reservationsService: ReservationsService,
    private readonly seatLock: SeatLockService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Criar reserva — requer buyer autenticado.
   * Retorna 409 se assentos não estão disponíveis (com lista dos indisponíveis).
   */
  @Post()
  @UseGuards(BuyerGuard)
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(CreateReservationSchema)) dto: CreateReservationDto,
  ): ReturnType<ReservationsService['create']> {
    return this.reservationsService.create(user.id, dto);
  }

  /**
   * Consultar reserva pelo id — usado pelo payment-service antes de criar
   * o Checkout no Stripe. Só retorna se a reserva pertence ao buyer autenticado
   * (evita IDOR: OWASP A01).
   *
   * Enriquecimento do response:
   *   - `eventTitle` e `thumbnailUrl` vêm da réplica local de Event (replicada
   *     via Kafka). São OBRIGATÓRIOS no payment-service para montar
   *     `product_data.name` e `images` do Stripe Checkout — Stripe rejeita
   *     session com string vazia (400 "You must specify product_data").
   *   - `ticketBatchName` vem da réplica local de TicketBatch (nome do lote,
   *     usado como descrição no line item do Stripe).
   *   - `seatLabel` não existe como réplica (assento é metadado do event-service);
   *     devolvemos null aqui — o payment-service usa só `ticketBatchName` nesse caso.
   *
   * Por que enriquecer aqui e não no payment-service?
   * O contrato entre serviços fica explícito — booking devolve tudo que payment
   * precisa em uma única chamada. Menos acoplamento lateral (payment não conhece
   * o schema de booking) e menos round-trips HTTP em série.
   */
  @Get(':id')
  @UseGuards(BuyerGuard)
  // Retorno é fronteira HTTP (JSON serializado): o corpo permanece
  // estritamente tipado; anotamos unknown só para satisfazer
  // explicit-function-return-type sem duplicar o shape enriquecido inline.
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<unknown> {
    const reservation = await this.prisma.reservation.findUnique({
      where: { id },
      include: { items: true },
    });

    // OWASP A01: 404 (não 403) quando o recurso pertence a outro usuário.
    // 403 vazaria a existência do UUID para um atacante tentando enumerar.
    if (!reservation || reservation.buyerId !== user.id) {
      throw new NotFoundException('Reserva não encontrada');
    }

    // Buscar réplicas locais em paralelo — ambas são leituras leves (índice por PK)
    const [event, batches] = await Promise.all([
      this.prisma.event.findUnique({
        where: { id: reservation.eventId },
        select: { title: true, thumbnailUrl: true },
      }),
      this.prisma.ticketBatch.findMany({
        where: { id: { in: reservation.items.map((i) => i.ticketBatchId) } },
        select: { id: true, name: true },
      }),
    ]);

    // Race benigna: se o consumer Kafka ainda não replicou, caímos em string
    // vazia → payment-service rejeita com 500. Melhor falhar cedo aqui com 404.
    if (!event) {
      throw new NotFoundException(
        'Evento ainda não foi replicado — tente novamente em instantes',
      );
    }

    const batchNameById = new Map(batches.map((b: { id: string; name: string }) => [b.id, b.name]));

    return {
      ...reservation,
      items: reservation.items.map((item) => ({
        ...item,
        ticketBatchName: batchNameById.get(item.ticketBatchId) ?? '',
        // seatLabel: não temos réplica de Seat — payment-service cai no fallback
        // (só mostra ticketBatchName na descrição do line item).
        seatLabel: null,
        eventTitle: event.title,
        thumbnailUrl: event.thumbnailUrl,
      })),
    };
  }

  /**
   * Cancelar reserva — libera locks e decrementa reservedCount.
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(BuyerGuard)
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): ReturnType<ReservationsService['cancel']> {
    return this.reservationsService.cancel(id, user.id);
  }

  /**
   * Verificar disponibilidade de assentos em tempo real.
   * Chamado pelo frontend a cada 10 segundos para atualizar o mapa visual.
   */
  @Get('availability/:eventId')
  getAvailability(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Body('seatIds') seatIds: string[],
  ): ReturnType<SeatLockService['checkAvailability']> {
    return this.seatLock.checkAvailability(eventId, seatIds);
  }
}