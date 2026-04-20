// apps/payment-service/src/modules/orders/orders.controller.ts
//
// Endpoints de checkout — exposto via gateway em /payments/orders.

import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  type AuthenticatedUser,
  CreateOrderSchema,
  type CreateOrderDto,
  CurrentUser,
} from '@showpass/types';

import { BuyerGuard } from '../../common/guards/buyer.guard.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { OrdersService } from './orders.service.js';

@Controller('payments/orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  /**
   * Cria Checkout Session no Stripe para as reservas informadas.
   * Requer buyer autenticado. Idempotente por conjunto (reservas + buyer).
   */
  @Post()
  @UseGuards(BuyerGuard)
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(CreateOrderSchema)) dto: CreateOrderDto,
    @Req() req: Request,
  ): Promise<{ orderId: string; checkoutUrl: string }> {
    // Repassar auth headers para o booking-service (autorização em cascata).
    // O booking.service confia nos mesmos headers que o gateway injeta aqui.
    const authHeaders: Record<string, string> = {
      'x-user-id': String(req.headers['x-user-id'] ?? ''),
      'x-user-type': String(req.headers['x-user-type'] ?? ''),
      'x-user-email': String(req.headers['x-user-email'] ?? ''),
    };

    return this.orders.createCheckout(user.id, dto.reservationIds, authHeaders);
  }

  /**
   * Consulta pedido — útil para o frontend atualizar o status após redirect
   * do Stripe (success/cancel URLs).
   */
  @Get(':id')
  @UseGuards(BuyerGuard)
  getOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.orders.getOrder(id, user.id);
  }
}
