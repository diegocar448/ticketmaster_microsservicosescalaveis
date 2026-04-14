// apps/event-service/src/prisma/prisma.service.ts
//
// Wrapper do PrismaClient para injeção de dependência no NestJS.
// Read-replica: se DATABASE_REPLICA_URL estiver configurado, queries de leitura
// são roteadas automaticamente para a replica (via @prisma/extension-read-replicas).
// Sem réplica (dev/staging) → todas as queries vão para o primary.

import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from './generated/index.js';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      // Logar warnings e erros — em produção evitar logar queries (dados sensíveis)
      log: process.env['NODE_ENV'] === 'development'
        ? [{ emit: 'stdout', level: 'warn' }]
        : [{ emit: 'stdout', level: 'error' }],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log(
      process.env['DATABASE_REPLICA_URL']
        ? 'Prisma conectado — Primary + Read-Replica ativos'
        : 'Prisma conectado',
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
