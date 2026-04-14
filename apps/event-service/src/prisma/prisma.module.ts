// apps/event-service/src/prisma/prisma.module.ts
//
// Módulo global — PrismaService disponível em todos os módulos do serviço
// sem precisar importar PrismaModule em cada feature module.

import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';

@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- padrão NestJS
export class PrismaModule {}
