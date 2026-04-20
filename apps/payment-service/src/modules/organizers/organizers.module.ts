// apps/payment-service/src/modules/organizers/organizers.module.ts

import { Module } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { OrganizersConsumer } from './organizers.consumer.js';

@Module({
  controllers: [OrganizersConsumer],
  providers: [PrismaService],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- padrão NestJS
export class OrganizersModule {}
