// apps/event-service/src/prisma/prisma.service.ts
//
// Wrapper do PrismaClient para injeção de dependência no NestJS.
// Read-replica: se DATABASE_REPLICA_URL estiver configurado, queries de leitura
// são roteadas automaticamente para a replica (via @prisma/extension-read-replicas).
// Sem réplica (dev/staging) → todas as queries vão para o primary.
//
// Prisma 7 "client" engine type exige driver adapter (@prisma/adapter-pg).
// O pool pg.Pool gerencia conexões — reutilizável entre queries (evita overhead
// de abrir/fechar socket TCP por query).

import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/index.js';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    // DATABASE_URL já foi carregado pelo dotenv no main.ts
    const pool = new Pool({ connectionString: process.env['DATABASE_URL'] });
    const adapter = new PrismaPg(pool);
    super({ adapter });
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
