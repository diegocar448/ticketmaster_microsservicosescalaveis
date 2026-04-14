// apps/event-service/src/modules/venues/venues.module.ts

import { Module } from '@nestjs/common';
import { VenuesService } from './venues.service.js';

@Module({
  // PrismaService não listado aqui — fornecido pelo PrismaModule global
  providers: [VenuesService],
  exports: [VenuesService],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- padrão NestJS
export class VenuesModule {}
