// apps/payment-service/src/modules/orders/orders.controller.ts
//
// Endpoints de checkout — exposto via gateway em /payments/orders.

import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Req,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import type { Request } from 'express';

import { CurrentUser, type AuthenticatedUser } from '@showpass/types';

import { OrdersService } from './orders.service.js';
import { BuyerGuard } from '../../common/guards/buyer.guard.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { CreateOrderSchema, type CreateOrderDto } from './dto/create-order.dto.js';

@Controller('payments/orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  @UseGuards(BuyerGuard)
  async create(
    @Body(new ZodValidationPipe(CreateOrderSchema)) dto: CreateOrderDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): ReturnType<OrdersService['createCheckout']> {
    // Repassa os headers x-user-* do gateway para o booking-service validar
    // a reserva também (defesa em profundidade — não confiamos só no gateway)
    const authHeaders: Record<string, string> = {
      'x-user-id': String(req.headers['x-user-id'] ?? ''),
      'x-user-type': String(req.headers['x-user-type'] ?? ''),
      'x-user-email': String(req.headers['x-user-email'] ?? ''),
    };

    return this.orders.createCheckout(user.id, dto.reservationIds, authHeaders);
  }

  @Get(':id')
  @UseGuards(BuyerGuard)
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): ReturnType<OrdersService['getOrder']> {
    return this.orders.getOrder(id, user.id);
  }
}