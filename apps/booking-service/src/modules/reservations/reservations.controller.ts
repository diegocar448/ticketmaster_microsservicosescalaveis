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
  ) {
    return this.reservationsService.create(user.id, dto);
  }

  /**
   * Consultar reserva pelo id — usado pelo payment-service antes de criar
   * o Checkout no Stripe. Só retorna se a reserva pertence ao buyer autenticado
   * (evita IDOR: OWASP A01).
   */
  @Get(':id')
  @UseGuards(BuyerGuard)
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const reservation = await this.prisma.reservation.findUnique({
      where: { id },
      include: { items: true },
    });

    if (!reservation || reservation.buyerId !== user.id) {
      // 404 em vez de 403 para não vazar existência do recurso.
      throw new NotFoundException('Reserva não encontrada');
    }

    return reservation;
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
  ) {
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
  ) {
    return this.seatLock.checkAvailability(eventId, seatIds);
  }
}