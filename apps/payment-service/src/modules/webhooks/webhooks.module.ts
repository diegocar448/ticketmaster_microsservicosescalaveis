// apps/payment-service/src/modules/webhooks/webhooks.module.ts

import { Module } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service.js';
import { WebhooksController } from './webhooks.controller.js';

@Module({
  controllers: [WebhooksController],
  providers: [PrismaService],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- padrão NestJS
export class WebhooksModule {}
