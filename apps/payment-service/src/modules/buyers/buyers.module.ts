// apps/payment-service/src/modules/buyers/buyers.module.ts

import { Module } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { BuyersConsumer } from './buyers.consumer.js';

@Module({
  controllers: [BuyersConsumer],
  providers: [PrismaService],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- padrão NestJS
export class BuyersModule {}
