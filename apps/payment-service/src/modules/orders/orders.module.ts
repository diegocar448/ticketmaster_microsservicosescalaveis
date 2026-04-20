// apps/payment-service/src/modules/orders/orders.module.ts

import { Module } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service.js';
import { OrdersController } from './orders.controller.js';
import { OrdersService } from './orders.service.js';

@Module({
  controllers: [OrdersController],
  providers: [OrdersService, PrismaService],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- padrão NestJS
export class OrdersModule {}
