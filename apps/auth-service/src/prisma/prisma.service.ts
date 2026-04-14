// apps/auth-service/src/prisma/prisma.service.ts
//
// Wrapper do Prisma Client como serviço NestJS.
// Herda de PrismaClient para expor os métodos de acesso ao banco diretamente.
//
// Prisma 7 usa driver adapters — passar adapter explicitamente em produção.
// Para desenvolvimento, definir DATABASE_URL no .env e usar @prisma/adapter-pg.

import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from './generated/index.js';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit(): Promise<void> {
    // Conectar explicitamente na inicialização para detectar problemas cedo
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    // Fechar conexões ao encerrar — evitar connection leaks em testes
    await this.$disconnect();
  }
}
